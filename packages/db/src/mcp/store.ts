import {
  DEFAULT_MCP_RATE_LIMIT_POLICY,
  generateOpaqueToken,
  MCP_ACCESS_TOKEN_TTL_MS,
  MCP_AUTH_CODE_TTL_MS,
  MCP_GRANT_MAX_LIFETIME_MS,
  MCP_PUBLISH_APPROVAL_TTL_MS,
  MCP_REFRESH_TOKEN_TTL_MS,
  parseAndNormalizeMcpScopes,
  sha256Hex,
  type CimdMetadataDocument,
  type McpRateLimitPolicy,
  type McpScope,
} from "@punyasitus/core/mcp/index";
import { buildPlatformAuditStatement, generatePlatformAuditId } from "../platform/audit.ts";

/**
 * `PLATFORM_DB` persistence layer for Tenant MCP Server OAuth 2.1 grants,
 * single-use PKCE auth codes, rotating refresh tokens, short-lived publish
 * approval tokens, and atomic rate-limit buckets (REQ-076, ADR-0008, TASK-075).
 *
 * Security invariants:
 * - Zero hot-path runtime DDL: relies strictly on `0030_mcp_oauth_grants.sql`.
 * - Raw authorization codes, access tokens, refresh tokens, and publish approval
 *   tokens are NEVER persisted; only SHA-256 hex digests are stored in SQLite.
 * - Operator-disabled clients (`mcp_oauth_clients.disabled = 1`) are honored everywhere
 *   (CIMD upsert, authorize, token refresh, and bearer verification).
 * - Authorization code reuse revokes the entire grant and all issued tokens.
 * - Refresh token rotation + new token insert + audit execute in ONE atomic `D1Database.batch`;
 *   refresh token replay revokes the entire token family and grant.
 * - Absolute grant lifetime ceiling (`MCP_GRANT_MAX_LIFETIME_MS`, 90 days) prevents indefinite sliding.
 */

export interface StoredMcpClient {
  readonly clientId: string;
  readonly clientName: string;
  readonly clientUri: string | null;
  readonly redirectUris: readonly string[];
  readonly source: "cimd" | "static";
  readonly disabled: boolean;
  readonly metadataFetchedAt: number | null;
}

export interface StoredMcpGrant {
  readonly id: string;
  readonly clientId: string;
  readonly clientName: string;
  readonly clientUri: string | null;
  readonly userId: string;
  readonly tenantId: string;
  readonly tenantHandle: string;
  readonly tenantName: string;
  readonly resource: string;
  readonly scopes: readonly McpScope[];
  readonly piiConsentAcked: boolean;
  readonly status: "active" | "revoked";
  readonly revokedAt: number | null;
  readonly revokedReason: string | null;
  readonly lastUsedAt: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface EligibleUserTenantForMcp {
  readonly tenantId: string;
  readonly organizationId: string;
  readonly handle: string;
  readonly name: string;
  readonly status: string;
  readonly dbRole: "owner" | "admin" | "editor" | "agency_staff" | "setup_staff";
  readonly eligible: boolean;
}

export interface StoredMcpAuthCode {
  readonly codeHash: string;
  readonly grantId: string;
  readonly clientId: string;
  readonly userId: string;
  readonly tenantId: string;
  readonly redirectUri: string;
  readonly resource: string;
  readonly scopes: readonly McpScope[];
  readonly codeChallenge: string;
  readonly codeChallengeMethod: "S256";
  readonly expiresAt: number;
  readonly consumedAt: number | null;
}

export interface LookedUpMcpAccessToken {
  readonly tokenId: string;
  readonly grantId: string;
  readonly familyId: string;
  readonly clientId: string;
  readonly clientName: string;
  readonly userId: string;
  readonly tenantId: string;
  readonly resource: string;
  readonly grantResource: string;
  readonly scopes: readonly McpScope[];
  readonly piiConsentAcked: boolean;
  readonly grantStatus: "active" | "revoked";
  readonly grantCreatedAt: number;
  readonly clientDisabled: boolean;
  readonly accessExpiresAt: number;
  readonly rotatedAt: number | null;
  readonly revokedAt: number | null;
}

export interface StoredMcpPublishApproval {
  readonly id: string;
  readonly grantId: string;
  readonly tenantId: string;
  readonly tenantHandle: string;
  readonly tenantName: string;
  readonly requestedByUserId: string;
  readonly clientId: string;
  readonly clientName: string;
  readonly resourceType: "page" | "post" | "offering";
  readonly resourceId: number;
  readonly expectedVersion: number;
  readonly resourceTitle: string;
  readonly resourceSlug: string | null;
  readonly status: "pending" | "approved" | "rejected" | "expired" | "held_for_review";
  readonly expiresAt: number;
  readonly resolvedAt: number | null;
  readonly resolvedByUserId: string | null;
  readonly reviewId: string | null;
  readonly createdAt: number;
}

function parseJsonStringArray(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    return [];
  }
}

function parseStoredScopes(raw: string): readonly McpScope[] {
  const arr = parseJsonStringArray(raw);
  const parsed = parseAndNormalizeMcpScopes(arr);
  return parsed.ok ? parsed.scopes : [];
}

/**
 * Upserts validated CIMD/static client metadata while PRESERVING any operator `disabled = 1` flag,
 * and returns the ACTUAL persisted `disabled` state from `PLATFORM_DB`.
 */
export async function upsertMcpOAuthClient(
  platformDb: D1Database,
  doc: CimdMetadataDocument,
  options: { readonly source?: "cimd" | "static"; readonly nowMs?: number } = {},
): Promise<StoredMcpClient> {
  const nowMs = Math.trunc(options.nowMs ?? Date.now());
  const source = options.source ?? "cimd";

  const row = await platformDb
    .prepare(
      `INSERT INTO mcp_oauth_clients (
         client_id, client_name, client_uri, redirect_uris_json, source,
         metadata_json, metadata_fetched_at, disabled, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
       ON CONFLICT(client_id) DO UPDATE SET
         client_name = excluded.client_name,
         client_uri = excluded.client_uri,
         redirect_uris_json = excluded.redirect_uris_json,
         source = excluded.source,
         metadata_json = excluded.metadata_json,
         metadata_fetched_at = excluded.metadata_fetched_at,
         updated_at = excluded.updated_at
       RETURNING client_id, client_name, client_uri, redirect_uris_json, source, disabled, metadata_fetched_at`,
    )
    .bind(
      doc.client_id,
      doc.client_name,
      doc.client_uri ?? null,
      JSON.stringify(doc.redirect_uris),
      source,
      JSON.stringify(doc),
      nowMs,
      nowMs,
      nowMs,
    )
    .first<{
      readonly client_id: string;
      readonly client_name: string;
      readonly client_uri: string | null;
      readonly redirect_uris_json: string;
      readonly source: "cimd" | "static";
      readonly disabled: number;
      readonly metadata_fetched_at: number | null;
    }>();

  if (!row) {
    throw new Error("Gagal menyimpan metadata klien OAuth MCP.");
  }

  return {
    clientId: row.client_id,
    clientName: row.client_name,
    clientUri: row.client_uri,
    redirectUris: parseJsonStringArray(row.redirect_uris_json),
    source: row.source,
    disabled: row.disabled === 1,
    metadataFetchedAt: row.metadata_fetched_at,
  };
}

export async function getMcpOAuthClient(
  platformDb: D1Database,
  clientId: string,
): Promise<StoredMcpClient | null> {
  const row = await platformDb
    .prepare(
      `SELECT client_id, client_name, client_uri, redirect_uris_json, source, disabled, metadata_fetched_at
       FROM mcp_oauth_clients
       WHERE client_id = ?
       LIMIT 1`,
    )
    .bind(clientId)
    .first<{
      readonly client_id: string;
      readonly client_name: string;
      readonly client_uri: string | null;
      readonly redirect_uris_json: string;
      readonly source: "cimd" | "static";
      readonly disabled: number;
      readonly metadata_fetched_at: number | null;
    }>();

  if (!row) return null;
  return {
    clientId: row.client_id,
    clientName: row.client_name,
    clientUri: row.client_uri,
    redirectUris: parseJsonStringArray(row.redirect_uris_json),
    source: row.source,
    disabled: row.disabled === 1,
    metadataFetchedAt: row.metadata_fetched_at,
  };
}

export async function getMcpGrantById(
  platformDb: D1Database,
  grantId: string,
): Promise<{
  readonly id: string;
  readonly userId: string;
  readonly tenantId: string;
  readonly clientId: string;
  readonly status: "active" | "revoked";
} | null> {
  const row = await platformDb
    .prepare(
      `SELECT id, user_id, tenant_id, client_id, status
       FROM mcp_oauth_grants
       WHERE id = ?
       LIMIT 1`,
    )
    .bind(grantId)
    .first<{
      readonly id: string;
      readonly user_id: string;
      readonly tenant_id: string;
      readonly client_id: string;
      readonly status: "active" | "revoked";
    }>();

  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    tenantId: row.tenant_id,
    clientId: row.client_id,
    status: row.status,
  };
}

/**
 * Lists all non-purged tenants the user belongs to, marking `owner` and `admin` roles
 * as eligible to connect AI agents (`editor` and other roles have `eligible: false`).
 */
export async function listUserTenantsForMcpConsent(
  platformDb: D1Database,
  userId: string,
): Promise<readonly EligibleUserTenantForMcp[]> {
  const res = await platformDb
    .prepare(
      `SELECT t.id AS tenant_id, t.organization_id, t.handle, t.name, t.status, m.role AS member_role
       FROM tenants t
       INNER JOIN members m
         ON m.organization_id = t.organization_id
        AND m.user_id = ?
       WHERE t.status != 'purged'
       ORDER BY t.created_at ASC`,
    )
    .bind(userId)
    .all<{
      readonly tenant_id: string;
      readonly organization_id: string;
      readonly handle: string;
      readonly name: string;
      readonly status: string;
      readonly member_role: "owner" | "admin" | "editor" | "agency_staff" | "setup_staff";
    }>();

  return (res.results ?? []).map((row) => ({
    tenantId: row.tenant_id,
    organizationId: row.organization_id,
    handle: row.handle,
    name: row.name,
    status: row.status,
    dbRole: row.member_role,
    eligible: row.member_role === "owner" || row.member_role === "admin",
  }));
}

export async function createMcpOAuthGrant(
  platformDb: D1Database,
  params: {
    readonly clientId: string;
    readonly userId: string;
    readonly tenantId: string;
    readonly resource: string;
    readonly scopes: readonly McpScope[];
    readonly piiConsentAcked: boolean;
    readonly requestId?: string | null;
    readonly nowMs?: number;
  },
): Promise<{ readonly grantId: string }> {
  const nowMs = Math.trunc(params.nowMs ?? Date.now());
  const grantId = generatePlatformAuditId(nowMs);

  const insertGrant = platformDb
    .prepare(
      `INSERT INTO mcp_oauth_grants (
         id, client_id, user_id, tenant_id, resource, scopes_json,
         pii_consent_acked, status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    )
    .bind(
      grantId,
      params.clientId,
      params.userId,
      params.tenantId,
      params.resource,
      JSON.stringify(params.scopes),
      params.piiConsentAcked ? 1 : 0,
      nowMs,
      nowMs,
    );

  const { statement: auditStmt } = buildPlatformAuditStatement(platformDb, {
    actorUserId: params.userId,
    actorRole: "tenant_member",
    action: "mcp.oauth.grant_created",
    targetType: "mcp_grant",
    targetId: grantId,
    tenantId: params.tenantId,
    outcome: "success",
    requestId: params.requestId ?? null,
    metadata: {
      clientId: params.clientId,
      resource: params.resource,
      scopes: params.scopes,
      piiConsentAcked: params.piiConsentAcked,
    },
    createdAtMs: nowMs,
  });

  await platformDb.batch([insertGrant, auditStmt]);
  return { grantId };
}

export async function listUserMcpGrants(
  platformDb: D1Database,
  userId: string,
  options: { readonly includeRevoked?: boolean; readonly includeOwnedTenantGrants?: boolean } = {},
): Promise<readonly StoredMcpGrant[]> {
  const statusFilter = options.includeRevoked ? "" : "AND g.status = 'active'";
  const ownerFilter = options.includeOwnedTenantGrants
    ? `(g.user_id = ? OR EXISTS (
         SELECT 1
         FROM tenants t2
         INNER JOIN members m2
           ON m2.organization_id = t2.organization_id
          AND m2.user_id = ?
          AND m2.role = 'owner'
         WHERE t2.id = g.tenant_id
       ))`
    : "g.user_id = ?";

  const bindings = options.includeOwnedTenantGrants ? [userId, userId] : [userId];

  const res = await platformDb
    .prepare(
      `SELECT g.id, g.client_id, c.client_name, c.client_uri, g.user_id,
              g.tenant_id, t.handle AS tenant_handle, t.name AS tenant_name,
              g.resource, g.scopes_json, g.pii_consent_acked, g.status,
              g.revoked_at, g.revoked_reason, g.last_used_at, g.created_at, g.updated_at
       FROM mcp_oauth_grants g
       INNER JOIN mcp_oauth_clients c ON c.client_id = g.client_id
       INNER JOIN tenants t ON t.id = g.tenant_id
       WHERE ${ownerFilter} ${statusFilter}
       ORDER BY g.created_at DESC
       LIMIT 100`,
    )
    .bind(...bindings)
    .all<{
      readonly id: string;
      readonly client_id: string;
      readonly client_name: string;
      readonly client_uri: string | null;
      readonly user_id: string;
      readonly tenant_id: string;
      readonly tenant_handle: string;
      readonly tenant_name: string;
      readonly resource: string;
      readonly scopes_json: string;
      readonly pii_consent_acked: number;
      readonly status: "active" | "revoked";
      readonly revoked_at: number | null;
      readonly revoked_reason: string | null;
      readonly last_used_at: number | null;
      readonly created_at: number;
      readonly updated_at: number;
    }>();

  return (res.results ?? []).map((row) => ({
    id: row.id,
    clientId: row.client_id,
    clientName: row.client_name,
    clientUri: row.client_uri,
    userId: row.user_id,
    tenantId: row.tenant_id,
    tenantHandle: row.tenant_handle,
    tenantName: row.tenant_name,
    resource: row.resource,
    scopes: parseStoredScopes(row.scopes_json),
    piiConsentAcked: row.pii_consent_acked === 1,
    status: row.status,
    revokedAt: row.revoked_at,
    revokedReason: row.revoked_reason,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export async function revokeMcpGrantById(
  platformDb: D1Database,
  params: {
    readonly grantId: string;
    readonly expectedUserId?: string;
    readonly actorUserId?: string;
    readonly reason: string;
    readonly actorRole?: string;
    readonly requestId?: string | null;
    readonly nowMs?: number;
  },
): Promise<{ readonly revoked: boolean; readonly tenantId: string | null }> {
  const nowMs = Math.trunc(params.nowMs ?? Date.now());

  const existing = await getMcpGrantById(platformDb, params.grantId);
  if (!existing) {
    return { revoked: false, tenantId: null };
  }
  if (params.expectedUserId && existing.userId !== params.expectedUserId) {
    return { revoked: false, tenantId: null };
  }

  const revokeGrantStmt = platformDb
    .prepare(
      `UPDATE mcp_oauth_grants
       SET status = 'revoked', revoked_at = COALESCE(revoked_at, ?),
           revoked_reason = COALESCE(revoked_reason, ?), updated_at = ?
       WHERE id = ?`,
    )
    .bind(nowMs, params.reason, nowMs, existing.id);

  const revokeTokensStmt = platformDb
    .prepare(
      `UPDATE mcp_oauth_tokens
       SET revoked_at = COALESCE(revoked_at, ?)
       WHERE grant_id = ?`,
    )
    .bind(nowMs, existing.id);

  const expireApprovalsStmt = platformDb
    .prepare(
      `UPDATE mcp_publish_approvals
       SET status = 'expired', resolved_at = COALESCE(resolved_at, ?)
       WHERE grant_id = ? AND status = 'pending'`,
    )
    .bind(nowMs, existing.id);

  const { statement: auditStmt } = buildPlatformAuditStatement(platformDb, {
    actorUserId: params.actorUserId ?? params.expectedUserId ?? existing.userId,
    actorRole: params.actorRole ?? "tenant_member",
    action: "mcp.oauth.grant_revoked",
    targetType: "mcp_grant",
    targetId: existing.id,
    tenantId: existing.tenantId,
    reason: params.reason,
    outcome: "success",
    requestId: params.requestId ?? null,
    metadata: {
      clientId: existing.clientId,
      grantOwnerUserId: existing.userId,
      previouslyRevoked: existing.status === "revoked",
    },
    createdAtMs: nowMs,
  });

  await platformDb.batch([revokeGrantStmt, revokeTokensStmt, expireApprovalsStmt, auditStmt]);
  return { revoked: true, tenantId: existing.tenantId };
}

export async function issueMcpAuthCode(
  platformDb: D1Database,
  params: {
    readonly grantId: string;
    readonly clientId: string;
    readonly userId: string;
    readonly tenantId: string;
    readonly redirectUri: string;
    readonly resource: string;
    readonly scopes: readonly McpScope[];
    readonly codeChallenge: string;
    readonly nowMs?: number;
  },
): Promise<{ readonly code: string; readonly expiresAt: number }> {
  const nowMs = Math.trunc(params.nowMs ?? Date.now());
  const expiresAt = nowMs + MCP_AUTH_CODE_TTL_MS;
  const rawCode = generateOpaqueToken("pscode", 32);
  const codeHash = await sha256Hex(rawCode);

  await platformDb
    .prepare(
      `INSERT INTO mcp_oauth_auth_codes (
         code_hash, grant_id, client_id, user_id, tenant_id, redirect_uri,
         resource, scopes_json, code_challenge, code_challenge_method,
         expires_at, consumed_at, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'S256', ?, NULL, ?)`,
    )
    .bind(
      codeHash,
      params.grantId,
      params.clientId,
      params.userId,
      params.tenantId,
      params.redirectUri,
      params.resource,
      JSON.stringify(params.scopes),
      params.codeChallenge,
      expiresAt,
      nowMs,
    )
    .run();

  return { code: rawCode, expiresAt };
}

export type ConsumeAuthCodeResult =
  | { readonly ok: true; readonly record: StoredMcpAuthCode }
  | {
      readonly ok: false;
      readonly reason: "not_found" | "expired" | "reused";
      readonly grantId?: string;
    };

/**
 * Atomically consumes a single-use authorization code.
 * If the code was ALREADY consumed (code replay attack), IMMEDIATELY revokes the entire
 * grant and all issued tokens per OAuth 2.1 §4.1.2 / ADR-0008.
 */
export async function consumeMcpAuthCodeAtomically(
  platformDb: D1Database,
  rawCode: string,
  options: { readonly requestId?: string | null; readonly nowMs?: number } = {},
): Promise<ConsumeAuthCodeResult> {
  const nowMs = Math.trunc(options.nowMs ?? Date.now());
  const codeHash = await sha256Hex(rawCode);

  const row = await platformDb
    .prepare(
      `SELECT code_hash, grant_id, client_id, user_id, tenant_id, redirect_uri,
              resource, scopes_json, code_challenge, code_challenge_method,
              expires_at, consumed_at
       FROM mcp_oauth_auth_codes
       WHERE code_hash = ?
       LIMIT 1`,
    )
    .bind(codeHash)
    .first<{
      readonly code_hash: string;
      readonly grant_id: string;
      readonly client_id: string;
      readonly user_id: string;
      readonly tenant_id: string;
      readonly redirect_uri: string;
      readonly resource: string;
      readonly scopes_json: string;
      readonly code_challenge: string;
      readonly code_challenge_method: "S256";
      readonly expires_at: number;
      readonly consumed_at: number | null;
    }>();

  if (!row) {
    return { ok: false, reason: "not_found" };
  }

  if (row.consumed_at !== null) {
    await revokeMcpGrantById(platformDb, {
      grantId: row.grant_id,
      reason: "authorization_code_replay_detected",
      actorRole: "system",
      requestId: options.requestId ?? null,
      nowMs,
    });
    return { ok: false, reason: "reused", grantId: row.grant_id };
  }

  if (nowMs >= row.expires_at) {
    return { ok: false, reason: "expired", grantId: row.grant_id };
  }

  const updateRes = await platformDb
    .prepare(
      `UPDATE mcp_oauth_auth_codes
       SET consumed_at = ?
       WHERE code_hash = ? AND consumed_at IS NULL`,
    )
    .bind(nowMs, codeHash)
    .run();

  if (Number(updateRes.meta?.changes ?? 0) !== 1) {
    await revokeMcpGrantById(platformDb, {
      grantId: row.grant_id,
      reason: "authorization_code_concurrent_replay_detected",
      actorRole: "system",
      requestId: options.requestId ?? null,
      nowMs,
    });
    return { ok: false, reason: "reused", grantId: row.grant_id };
  }

  return {
    ok: true,
    record: {
      codeHash: row.code_hash,
      grantId: row.grant_id,
      clientId: row.client_id,
      userId: row.user_id,
      tenantId: row.tenant_id,
      redirectUri: row.redirect_uri,
      resource: row.resource,
      scopes: parseStoredScopes(row.scopes_json),
      codeChallenge: row.code_challenge,
      codeChallengeMethod: row.code_challenge_method,
      expiresAt: row.expires_at,
      consumedAt: nowMs,
    },
  };
}

export interface IssuedMcpTokenPair {
  readonly tokenId: string;
  readonly familyId: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly accessExpiresAt: number;
  readonly refreshExpiresAt: number;
  readonly expiresInSeconds: number;
}

export async function issueMcpTokenPair(
  platformDb: D1Database,
  params: {
    readonly grantId: string;
    readonly familyId?: string;
    readonly resource: string;
    readonly scopes: readonly McpScope[];
    readonly nowMs?: number;
  },
): Promise<IssuedMcpTokenPair> {
  const nowMs = Math.trunc(params.nowMs ?? Date.now());
  const tokenId = generatePlatformAuditId(nowMs);
  const familyId = params.familyId ?? generatePlatformAuditId(nowMs);
  const accessToken = generateOpaqueToken("psmcp", 32);
  const refreshToken = generateOpaqueToken("psrt", 32);
  const [accessHash, refreshHash] = await Promise.all([
    sha256Hex(accessToken),
    sha256Hex(refreshToken),
  ]);
  const accessExpiresAt = nowMs + MCP_ACCESS_TOKEN_TTL_MS;
  const refreshExpiresAt = nowMs + MCP_REFRESH_TOKEN_TTL_MS;

  await platformDb
    .prepare(
      `INSERT INTO mcp_oauth_tokens (
         id, grant_id, family_id, access_token_hash, refresh_token_hash,
         resource, scopes_json, access_expires_at, refresh_expires_at,
         rotated_at, revoked_at, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
    )
    .bind(
      tokenId,
      params.grantId,
      familyId,
      accessHash,
      refreshHash,
      params.resource,
      JSON.stringify(params.scopes),
      accessExpiresAt,
      refreshExpiresAt,
      nowMs,
    )
    .run();

  return {
    tokenId,
    familyId,
    accessToken,
    refreshToken,
    accessExpiresAt,
    refreshExpiresAt,
    expiresInSeconds: Math.floor(MCP_ACCESS_TOKEN_TTL_MS / 1000),
  };
}

export async function lookupMcpAccessToken(
  platformDb: D1Database,
  rawAccessToken: string,
): Promise<LookedUpMcpAccessToken | null> {
  const tokenHash = await sha256Hex(rawAccessToken);

  const row = await platformDb
    .prepare(
      `SELECT t.id AS token_id, t.grant_id, t.family_id, t.resource AS token_resource,
              t.scopes_json AS token_scopes_json, t.access_expires_at, t.rotated_at, t.revoked_at,
              g.client_id, g.user_id, g.tenant_id, g.resource AS grant_resource,
              g.pii_consent_acked, g.status AS grant_status, g.created_at AS grant_created_at,
              c.client_name, c.disabled AS client_disabled
       FROM mcp_oauth_tokens t
       INNER JOIN mcp_oauth_grants g ON g.id = t.grant_id
       INNER JOIN mcp_oauth_clients c ON c.client_id = g.client_id
       WHERE t.access_token_hash = ?
       LIMIT 1`,
    )
    .bind(tokenHash)
    .first<{
      readonly token_id: string;
      readonly grant_id: string;
      readonly family_id: string;
      readonly token_resource: string;
      readonly token_scopes_json: string;
      readonly access_expires_at: number;
      readonly rotated_at: number | null;
      readonly revoked_at: number | null;
      readonly client_id: string;
      readonly user_id: string;
      readonly tenant_id: string;
      readonly grant_resource: string;
      readonly pii_consent_acked: number;
      readonly grant_status: "active" | "revoked";
      readonly grant_created_at: number;
      readonly client_name: string;
      readonly client_disabled: number;
    }>();

  if (!row) return null;

  return {
    tokenId: row.token_id,
    grantId: row.grant_id,
    familyId: row.family_id,
    clientId: row.client_id,
    clientName: row.client_name,
    userId: row.user_id,
    tenantId: row.tenant_id,
    resource: row.token_resource,
    grantResource: row.grant_resource,
    scopes: parseStoredScopes(row.token_scopes_json),
    piiConsentAcked: row.pii_consent_acked === 1,
    grantStatus: row.grant_status,
    grantCreatedAt: row.grant_created_at,
    clientDisabled: row.client_disabled === 1,
    accessExpiresAt: row.access_expires_at,
    rotatedAt: row.rotated_at,
    revokedAt: row.revoked_at,
  };
}

export async function touchMcpGrantLastUsedBestEffort(
  platformDb: D1Database,
  grantId: string,
  nowMs: number,
): Promise<void> {
  try {
    await platformDb
      .prepare(`UPDATE mcp_oauth_grants SET last_used_at = ?, updated_at = ? WHERE id = ?`)
      .bind(nowMs, nowMs, grantId)
      .run();
  } catch {
    // Non-blocking telemetry timestamp
  }
}

export type RotateRefreshTokenResult =
  | {
      readonly ok: true;
      readonly grantId: string;
      readonly userId: string;
      readonly tenantId: string;
      readonly clientId: string;
      readonly resource: string;
      readonly scopes: readonly McpScope[];
      readonly tokenPair: IssuedMcpTokenPair;
    }
  | {
      readonly ok: false;
      readonly reason:
        | "not_found"
        | "client_mismatch"
        | "client_disabled"
        | "resource_mismatch"
        | "expired"
        | "grant_lifetime_exceeded"
        | "replayed"
        | "revoked";
    };

/**
 * Atomically rotates a refresh token + inserts the replacement token pair + appends audit
 * inside ONE `D1Database.batch([...])` transaction.
 *
 * Security invariants:
 * - Honors `mcp_oauth_clients.disabled = 1` (refuses refresh).
 * - Enforces absolute grant max lifetime (`MCP_GRANT_MAX_LIFETIME_MS`, 90 days).
 * - If an already-rotated refresh token is replayed, IMMEDIATELY revokes the entire
 *   token family and parent grant (OAuth 2.1 §4.3.1 / ADR-0008).
 */
export async function rotateMcpRefreshTokenAtomically(
  platformDb: D1Database,
  params: {
    readonly rawRefreshToken: string;
    readonly clientId: string;
    readonly requestedResource: string;
    readonly requestId?: string | null;
    readonly nowMs?: number;
  },
): Promise<RotateRefreshTokenResult> {
  const nowMs = Math.trunc(params.nowMs ?? Date.now());
  const refreshHash = await sha256Hex(params.rawRefreshToken);

  const row = await platformDb
    .prepare(
      `SELECT t.id AS token_id, t.grant_id, t.family_id, t.resource AS token_resource,
              t.scopes_json AS token_scopes_json, t.refresh_expires_at, t.rotated_at, t.revoked_at,
              g.client_id, g.user_id, g.tenant_id, g.status AS grant_status, g.created_at AS grant_created_at,
              c.disabled AS client_disabled
       FROM mcp_oauth_tokens t
       INNER JOIN mcp_oauth_grants g ON g.id = t.grant_id
       INNER JOIN mcp_oauth_clients c ON c.client_id = g.client_id
       WHERE t.refresh_token_hash = ?
       LIMIT 1`,
    )
    .bind(refreshHash)
    .first<{
      readonly token_id: string;
      readonly grant_id: string;
      readonly family_id: string;
      readonly token_resource: string;
      readonly token_scopes_json: string;
      readonly refresh_expires_at: number | null;
      readonly rotated_at: number | null;
      readonly revoked_at: number | null;
      readonly client_id: string;
      readonly user_id: string;
      readonly tenant_id: string;
      readonly grant_status: "active" | "revoked";
      readonly grant_created_at: number;
      readonly client_disabled: number;
    }>();

  if (!row) {
    return { ok: false, reason: "not_found" };
  }

  // Refresh token replay detection (rotated token reused) -> REVOKE ENTIRE GRANT FAMILY!
  if (row.rotated_at !== null) {
    await revokeMcpGrantById(platformDb, {
      grantId: row.grant_id,
      reason: "refresh_token_replay_detected",
      actorRole: "system",
      requestId: params.requestId ?? null,
      nowMs,
    });
    return { ok: false, reason: "replayed" };
  }

  if (row.client_disabled === 1) {
    return { ok: false, reason: "client_disabled" };
  }

  if (row.revoked_at !== null || row.grant_status !== "active") {
    return { ok: false, reason: "revoked" };
  }

  if (row.client_id !== params.clientId) {
    return { ok: false, reason: "client_mismatch" };
  }

  if (row.token_resource !== params.requestedResource) {
    return { ok: false, reason: "resource_mismatch" };
  }

  // Absolute grant ceiling prevents sliding 7-day refreshes from extending indefinitely
  const grantAbsoluteExpiryMs = row.grant_created_at + MCP_GRANT_MAX_LIFETIME_MS;
  if (nowMs >= grantAbsoluteExpiryMs) {
    await revokeMcpGrantById(platformDb, {
      grantId: row.grant_id,
      reason: "grant_max_lifetime_exceeded",
      actorRole: "system",
      requestId: params.requestId ?? null,
      nowMs,
    });
    return { ok: false, reason: "grant_lifetime_exceeded" };
  }

  if (row.refresh_expires_at === null || nowMs >= row.refresh_expires_at) {
    return { ok: false, reason: "expired" };
  }

  // Pre-mint replacement token pair so rotate + insert + audit commit in ONE atomic D1 batch
  const scopes = parseStoredScopes(row.token_scopes_json);
  const newTokenId = generatePlatformAuditId(nowMs);
  const newAccessToken = generateOpaqueToken("psmcp", 32);
  const newRefreshToken = generateOpaqueToken("psrt", 32);
  const [newAccessHash, newRefreshHash] = await Promise.all([
    sha256Hex(newAccessToken),
    sha256Hex(newRefreshToken),
  ]);
  const accessExpiresAt = Math.min(nowMs + MCP_ACCESS_TOKEN_TTL_MS, grantAbsoluteExpiryMs);
  const refreshExpiresAt = Math.min(nowMs + MCP_REFRESH_TOKEN_TTL_MS, grantAbsoluteExpiryMs);

  const rotateStmt = platformDb
    .prepare(
      `UPDATE mcp_oauth_tokens
       SET rotated_at = ?, revoked_at = COALESCE(revoked_at, ?)
       WHERE id = ? AND rotated_at IS NULL AND revoked_at IS NULL`,
    )
    .bind(nowMs, nowMs, row.token_id);

  const insertNewStmt = platformDb
    .prepare(
      `INSERT INTO mcp_oauth_tokens (
         id, grant_id, family_id, access_token_hash, refresh_token_hash,
         resource, scopes_json, access_expires_at, refresh_expires_at,
         rotated_at, revoked_at, created_at
       )
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?
       WHERE changes() = 1`,
    )
    .bind(
      newTokenId,
      row.grant_id,
      row.family_id,
      newAccessHash,
      newRefreshHash,
      row.token_resource,
      JSON.stringify(scopes),
      accessExpiresAt,
      refreshExpiresAt,
      nowMs,
    );

  const { statement: auditStmt } = buildPlatformAuditStatement(
    platformDb,
    {
      actorUserId: row.user_id,
      actorRole: "tenant_member",
      action: "mcp.oauth.token_refreshed",
      targetType: "mcp_grant",
      targetId: row.grant_id,
      tenantId: row.tenant_id,
      outcome: "success",
      requestId: params.requestId ?? null,
      metadata: { clientId: row.client_id, familyId: row.family_id },
      createdAtMs: nowMs,
    },
    { onlyIfPreviousChanged: true },
  );

  const batchResults = await platformDb.batch([rotateStmt, insertNewStmt, auditStmt]);
  const rotatedChanges = Number(batchResults[0]?.meta?.changes ?? 0);

  if (rotatedChanges !== 1) {
    // Concurrent replay race -> revoke entire grant family
    await revokeMcpGrantById(platformDb, {
      grantId: row.grant_id,
      reason: "refresh_token_concurrent_replay_detected",
      actorRole: "system",
      requestId: params.requestId ?? null,
      nowMs,
    });
    return { ok: false, reason: "replayed" };
  }

  return {
    ok: true,
    grantId: row.grant_id,
    userId: row.user_id,
    tenantId: row.tenant_id,
    clientId: row.client_id,
    resource: row.token_resource,
    scopes,
    tokenPair: {
      tokenId: newTokenId,
      familyId: row.family_id,
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
      accessExpiresAt,
      refreshExpiresAt,
      expiresInSeconds: Math.max(1, Math.floor((accessExpiresAt - nowMs) / 1000)),
    },
  };
}

export async function revokeMcpTokenByValue(
  platformDb: D1Database,
  rawToken: string,
  options: { readonly clientId?: string; readonly requestId?: string | null; readonly nowMs?: number } = {},
): Promise<{ readonly revoked: boolean }> {
  const hash = await sha256Hex(rawToken);
  const row = await platformDb
    .prepare(
      `SELECT t.grant_id, g.client_id
       FROM mcp_oauth_tokens t
       INNER JOIN mcp_oauth_grants g ON g.id = t.grant_id
       WHERE t.access_token_hash = ? OR t.refresh_token_hash = ?
       LIMIT 1`,
    )
    .bind(hash, hash)
    .first<{ readonly grant_id: string; readonly client_id: string }>();

  if (!row) {
    return { revoked: false };
  }
  if (options.clientId && row.client_id !== options.clientId) {
    return { revoked: false };
  }

  await revokeMcpGrantById(platformDb, {
    grantId: row.grant_id,
    reason: "oauth_token_revocation_endpoint",
    actorRole: "mcp_client",
    requestId: options.requestId ?? null,
    nowMs: options.nowMs,
  });
  return { revoked: true };
}

// ---------------------------------------------------------------------------
// Short-Lived Single-Use Publish Approval Tokens (Atomic Claim-First)
// ---------------------------------------------------------------------------

export async function createMcpPublishApproval(
  platformDb: D1Database,
  params: {
    readonly grantId: string;
    readonly tenantId: string;
    readonly requestedByUserId: string;
    readonly clientId: string;
    readonly resourceType: "page" | "post" | "offering";
    readonly resourceId: number;
    readonly expectedVersion: number;
    readonly resourceTitle: string;
    readonly resourceSlug: string | null;
    readonly nowMs?: number;
  },
): Promise<{ readonly id: string; readonly token: string; readonly expiresAt: number }> {
  const nowMs = Math.trunc(params.nowMs ?? Date.now());
  const id = generatePlatformAuditId(nowMs);
  const token = generateOpaqueToken("pspub", 24);
  const tokenHash = await sha256Hex(token);
  const expiresAt = nowMs + MCP_PUBLISH_APPROVAL_TTL_MS;

  await platformDb
    .prepare(
      `INSERT INTO mcp_publish_approvals (
         id, token_hash, grant_id, tenant_id, requested_by_user_id, client_id,
         resource_type, resource_id, expected_version, resource_title, resource_slug,
         status, expires_at, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    )
    .bind(
      id,
      tokenHash,
      params.grantId,
      params.tenantId,
      params.requestedByUserId,
      params.clientId,
      params.resourceType,
      params.resourceId,
      params.expectedVersion,
      params.resourceTitle,
      params.resourceSlug,
      expiresAt,
      nowMs,
    )
    .run();

  return { id, token, expiresAt };
}

export async function getMcpPublishApprovalByToken(
  platformDb: D1Database,
  rawToken: string,
): Promise<StoredMcpPublishApproval | null> {
  const tokenHash = await sha256Hex(rawToken);
  const row = await platformDb
    .prepare(
      `SELECT a.id, a.grant_id, a.tenant_id, t.handle AS tenant_handle, t.name AS tenant_name,
              a.requested_by_user_id, a.client_id, c.client_name,
              a.resource_type, a.resource_id, a.expected_version,
              a.resource_title, a.resource_slug, a.status,
              a.expires_at, a.resolved_at, a.resolved_by_user_id, a.review_id, a.created_at
       FROM mcp_publish_approvals a
       INNER JOIN tenants t ON t.id = a.tenant_id
       INNER JOIN mcp_oauth_clients c ON c.client_id = a.client_id
       WHERE a.token_hash = ?
       LIMIT 1`,
    )
    .bind(tokenHash)
    .first<{
      readonly id: string;
      readonly grant_id: string;
      readonly tenant_id: string;
      readonly tenant_handle: string;
      readonly tenant_name: string;
      readonly requested_by_user_id: string;
      readonly client_id: string;
      readonly client_name: string;
      readonly resource_type: "page" | "post" | "offering";
      readonly resource_id: number;
      readonly expected_version: number;
      readonly resource_title: string;
      readonly resource_slug: string | null;
      readonly status: "pending" | "approved" | "rejected" | "expired" | "held_for_review";
      readonly expires_at: number;
      readonly resolved_at: number | null;
      readonly resolved_by_user_id: string | null;
      readonly review_id: string | null;
      readonly created_at: number;
    }>();

  if (!row) return null;
  return {
    id: row.id,
    grantId: row.grant_id,
    tenantId: row.tenant_id,
    tenantHandle: row.tenant_handle,
    tenantName: row.tenant_name,
    requestedByUserId: row.requested_by_user_id,
    clientId: row.client_id,
    clientName: row.client_name,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    expectedVersion: row.expected_version,
    resourceTitle: row.resource_title,
    resourceSlug: row.resource_slug,
    status: row.status,
    expiresAt: row.expires_at,
    resolvedAt: row.resolved_at,
    resolvedByUserId: row.resolved_by_user_id,
    reviewId: row.review_id,
    createdAt: row.created_at,
  };
}

/**
 * Atomically claims a pending, unexpired publish approval token BEFORE invoking publication.
 * Guarantees at-most-once execution even under concurrent clicks/requests.
 */
export async function claimPendingMcpPublishApprovalAtomically(
  platformDb: D1Database,
  params: {
    readonly approvalId: string;
    readonly nextStatus: "approved" | "rejected";
    readonly resolvedByUserId: string;
    readonly nowMs: number;
  },
): Promise<boolean> {
  const res = await platformDb
    .prepare(
      `UPDATE mcp_publish_approvals
       SET status = ?, resolved_at = ?, resolved_by_user_id = ?
       WHERE id = ? AND status = 'pending' AND expires_at > ?`,
    )
    .bind(params.nextStatus, params.nowMs, params.resolvedByUserId, params.approvalId, params.nowMs)
    .run();
  return Number(res.meta?.changes ?? 0) === 1;
}

export async function markMcpPublishApprovalExpired(
  platformDb: D1Database,
  approvalId: string,
  resolvedByUserId: string | null,
  nowMs: number,
): Promise<void> {
  await platformDb
    .prepare(
      `UPDATE mcp_publish_approvals
       SET status = 'expired', resolved_at = ?, resolved_by_user_id = ?
       WHERE id = ? AND status = 'pending'`,
    )
    .bind(nowMs, resolvedByUserId, approvalId)
    .run();
}

export async function updateClaimedMcpPublishApprovalToHeld(
  platformDb: D1Database,
  params: {
    readonly approvalId: string;
    readonly reviewId: string;
    readonly resolvedByUserId: string;
    readonly nowMs: number;
  },
): Promise<void> {
  await platformDb
    .prepare(
      `UPDATE mcp_publish_approvals
       SET status = 'held_for_review', review_id = ?
       WHERE id = ? AND status = 'approved' AND resolved_at = ? AND resolved_by_user_id = ?`,
    )
    .bind(params.reviewId, params.approvalId, params.nowMs, params.resolvedByUserId)
    .run();
}

/**
 * Compensating rollback if `publishResourceWithScreening` throws after atomic pre-claim.
 */
export async function releaseClaimedMcpPublishApprovalOnError(
  platformDb: D1Database,
  params: {
    readonly approvalId: string;
    readonly resolvedByUserId: string;
    readonly nowMs: number;
  },
): Promise<void> {
  await platformDb
    .prepare(
      `UPDATE mcp_publish_approvals
       SET status = 'pending', resolved_at = NULL, resolved_by_user_id = NULL
       WHERE id = ? AND status = 'approved' AND resolved_at = ? AND resolved_by_user_id = ?`,
    )
    .bind(params.approvalId, params.nowMs, params.resolvedByUserId)
    .run();
}

// ---------------------------------------------------------------------------
// Atomic Per-Token, Per-Tenant & Authorize-Endpoint MCP Rate Limiters
// ---------------------------------------------------------------------------

export type McpRateLimitOutcome =
  | { readonly allowed: true; readonly remaining: number; readonly resetAtMs: number }
  | {
      readonly allowed: false;
      readonly violatedBucket: "per_token" | "per_tenant" | "authorize_ip" | "authorize_global";
      readonly retryAfterSeconds: number;
      readonly resetAtMs: number;
    };

async function incrementBucket(
  platformDb: D1Database,
  bucketKey: string,
  windowStart: number,
  nowMs: number,
): Promise<number> {
  const row = await platformDb
    .prepare(
      `INSERT INTO mcp_rate_limit_buckets (bucket_key, window_start, count, updated_at)
       VALUES (?, ?, 1, ?)
       ON CONFLICT(bucket_key) DO UPDATE SET
         count = CASE
           WHEN mcp_rate_limit_buckets.window_start = excluded.window_start
           THEN mcp_rate_limit_buckets.count + 1
           ELSE 1
         END,
         window_start = excluded.window_start,
         updated_at = excluded.updated_at
       RETURNING count`,
    )
    .bind(bucketKey, windowStart, nowMs)
    .first<{ readonly count: number }>();

  return Number(row?.count ?? 1);
}

/**
 * Atomically enforces per-grant/token AND per-tenant MCP request rate limits.
 */
export async function consumeMcpRateLimit(
  platformDb: D1Database,
  params: {
    readonly grantId: string;
    readonly tenantId: string;
    readonly policy?: McpRateLimitPolicy;
    readonly nowMs?: number;
  },
): Promise<McpRateLimitOutcome> {
  const policy = params.policy ?? DEFAULT_MCP_RATE_LIMIT_POLICY;
  const nowMs = Math.trunc(params.nowMs ?? Date.now());
  const windowMs = Math.max(1000, policy.windowMs);
  const windowStart = Math.floor(nowMs / windowMs) * windowMs;
  const resetAtMs = windowStart + windowMs;
  const retryAfterSeconds = Math.max(1, Math.ceil((resetAtMs - nowMs) / 1000));

  const [tokenCount, tenantCount] = await Promise.all([
    incrementBucket(platformDb, `mcp:grant:${params.grantId}`, windowStart, nowMs),
    incrementBucket(platformDb, `mcp:tenant:${params.tenantId}`, windowStart, nowMs),
  ]);

  if (tokenCount > policy.perTokenPerMinute) {
    return {
      allowed: false,
      violatedBucket: "per_token",
      retryAfterSeconds,
      resetAtMs,
    };
  }

  if (tenantCount > policy.perTenantPerMinute) {
    return {
      allowed: false,
      violatedBucket: "per_tenant",
      retryAfterSeconds,
      resetAtMs,
    };
  }

  return {
    allowed: true,
    remaining: Math.min(
      Math.max(0, policy.perTokenPerMinute - tokenCount),
      Math.max(0, policy.perTenantPerMinute - tenantCount),
    ),
    resetAtMs,
  };
}

/**
 * Atomically rate-limits `GET /oauth2/authorize` BEFORE any outbound CIMD fetch or D1 upsert,
 * preventing unauthenticated SSRF-fetch / D1-write amplification.
 */
export async function consumeMcpAuthorizeRateLimit(
  platformDb: D1Database,
  params: {
    readonly callerKey: string;
    readonly perCallerPerMinute?: number;
    readonly globalPerMinute?: number;
    readonly windowMs?: number;
    readonly nowMs?: number;
  },
): Promise<McpRateLimitOutcome> {
  const nowMs = Math.trunc(params.nowMs ?? Date.now());
  const windowMs = Math.max(1000, params.windowMs ?? 60_000);
  const perCallerLimit = Math.max(1, params.perCallerPerMinute ?? 20);
  const globalLimit = Math.max(1, params.globalPerMinute ?? 120);
  const windowStart = Math.floor(nowMs / windowMs) * windowMs;
  const resetAtMs = windowStart + windowMs;
  const retryAfterSeconds = Math.max(1, Math.ceil((resetAtMs - nowMs) / 1000));

  const callerHash = (await sha256Hex(params.callerKey)).slice(0, 32);
  const [callerCount, globalCount] = await Promise.all([
    incrementBucket(platformDb, `mcp:authz:ip:${callerHash}`, windowStart, nowMs),
    incrementBucket(platformDb, "mcp:authz:global", windowStart, nowMs),
  ]);

  if (callerCount > perCallerLimit) {
    return {
      allowed: false,
      violatedBucket: "authorize_ip",
      retryAfterSeconds,
      resetAtMs,
    };
  }

  if (globalCount > globalLimit) {
    return {
      allowed: false,
      violatedBucket: "authorize_global",
      retryAfterSeconds,
      resetAtMs,
    };
  }

  return {
    allowed: true,
    remaining: Math.min(Math.max(0, perCallerLimit - callerCount), Math.max(0, globalLimit - globalCount)),
    resetAtMs,
  };
}

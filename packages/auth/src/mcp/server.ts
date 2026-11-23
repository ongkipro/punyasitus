import {
  buildCanonicalMcpResource,
  isMcpAllowedToolName,
  isMcpExcludedToolName,
  JsonRpcRequestSchema,
  listToolsForGrantedScopes,
  MCP_MAX_REQUEST_BODY_BYTES,
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_INFO,
  MCP_SUPPORTED_PROTOCOL_VERSIONS,
  MCP_TOOL_REQUIRED_SCOPE,
  McpToolCallParamsSchema,
  type McpRateLimitPolicy,
} from "@punyasitus/core/mcp/index";
import {
  consumeMcpRateLimit,
  executeTenantMcpTool,
  McpToolExecutionError,
} from "@punyasitus/db/mcp/index";
import { appendPlatformAudit, generatePlatformAuditId } from "@punyasitus/db/platform";
import { hasHostSessionCookie } from "../cookies.ts";
import { verifyMcpBearerAccess } from "./oauth.ts";

/**
 * Streamable HTTP Tenant MCP JSON-RPC 2.0 Server (`packages/auth/src/mcp/server.ts`).
 *
 * Security invariants (REQ-076, ADR-0008, PLAN §18.3, TASK-075):
 * - Admin host ONLY (`app.punyasitus.com` or local loopback); caller enforces 404 on other hosts.
 * - Strictly Bearer token authentication: `__Host-` session cookies are REJECTED (401) and NEVER used.
 * - Live per-call verification of token, RFC 8707 `resource`, active `owner`/`admin` membership,
 *   and active tenant entitlement (`locked`/`suspended` tenants return error with ZERO data).
 * - Strict tool allowlist; excluded tools are absent from `tools/list` AND rejected on `tools/call`.
 * - Every call is rate-limited (per-token & per-tenant) and audited in `platform_audit` with redaction.
 */

export interface McpServerRequestDeps {
  readonly platformDb: D1Database;
  readonly adminOrigin: string;
  readonly openTenantDb: (tenantId: string) => Promise<D1Database> | D1Database;
  readonly rateLimitPolicy?: McpRateLimitPolicy;
  readonly nowMs?: number;
}

function buildWwwAuthenticateHeader(
  adminOrigin: string,
  error: string,
  description: string,
): string {
  const cleanOrigin = adminOrigin.replace(/\/+$/, "");
  const safeDesc = description.replace(/"/g, "'");
  return `Bearer resource_metadata="${cleanOrigin}/.well-known/oauth-protected-resource", error="${error}", error_description="${safeDesc}"`;
}

function jsonRpcResponse(
  status: number,
  body: Record<string, unknown>,
  extraHeaders?: Readonly<Record<string, string>>,
): Response {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Robots-Tag": "noindex, nofollow",
    ...extraHeaders,
  });
  return new Response(JSON.stringify(body), { status, headers });
}

function jsonRpcErrorPayload(
  id: string | number | null,
  code: number,
  message: string,
  data?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
      ...(data ? { data } : {}),
    },
  };
}

export async function handleMcpHttpRequest(
  request: Request,
  deps: McpServerRequestDeps,
): Promise<Response> {
  const nowMs = Math.trunc(deps.nowMs ?? Date.now());
  const requestId =
    request.headers.get("x-request-id")?.trim() || `mcp_${generatePlatformAuditId(nowMs)}`;
  const method = request.method.toUpperCase();
  const canonicalResource = buildCanonicalMcpResource(deps.adminOrigin);

  // 1. Session cookies are NEVER accepted on `/mcp` (PLAN §4, TASK-025, TASK-075).
  if (hasHostSessionCookie(request.headers.get("cookie"))) {
    return jsonRpcResponse(
      401,
      {
        error: "invalid_token",
        error_description: "Cookie sesi tidak pernah diterima pada endpoint /mcp; gunakan Bearer token.",
      },
      {
        "WWW-Authenticate": buildWwwAuthenticateHeader(
          deps.adminOrigin,
          "invalid_token",
          "Session cookies are ignored on /mcp; use OAuth Bearer token",
        ),
      },
    );
  }

  if (method === "GET") {
    return jsonRpcResponse(405, {
      error: "method_not_allowed",
      message: "Endpoint MCP menggunakan Streamable HTTP JSON-RPC via POST /mcp.",
    }, { Allow: "POST, DELETE" });
  }

  if (method === "DELETE") {
    // Streamable HTTP session termination (stateless per-request Worker)
    return new Response(null, {
      status: 204,
      headers: {
        "Cache-Control": "no-store",
        "X-Robots-Tag": "noindex, nofollow",
      },
    });
  }

  if (method !== "POST") {
    return jsonRpcResponse(
      405,
      { error: "method_not_allowed", message: "Gunakan POST untuk panggilan JSON-RPC MCP." },
      { Allow: "POST, DELETE" },
    );
  }

  // 2. Live per-call bearer token, RFC 8707 resource, owner/admin membership & entitlement check!
  const authResult = await verifyMcpBearerAccess(deps.platformDb, {
    authorizationHeader: request.headers.get("authorization"),
    canonicalResource,
    nowMs,
  });

  if (!authResult.ok) {
    if (authResult.grantId && authResult.tenantId) {
      await appendPlatformAudit(deps.platformDb, {
        actorUserId: authResult.userId ?? null,
        actorRole: "mcp_client",
        action: "mcp.request.denied",
        targetType: "mcp_grant",
        targetId: authResult.grantId,
        tenantId: authResult.tenantId,
        reason: authResult.code,
        outcome: "denied",
        requestId,
        metadata: {
          clientId: authResult.clientId ?? null,
          errorCode: authResult.code,
        },
        createdAtMs: nowMs,
      }).catch(() => undefined);
    }

    const extraHeaders: Record<string, string> = {
      "X-Request-Id": requestId,
    };
    if (authResult.status === 401) {
      extraHeaders["WWW-Authenticate"] = buildWwwAuthenticateHeader(
        deps.adminOrigin,
        authResult.oauthError,
        authResult.message,
      );
    }
    return jsonRpcResponse(
      authResult.status,
      {
        error: authResult.oauthError,
        code: authResult.code,
        message: authResult.message,
      },
      extraHeaders,
    );
  }

  const ctx = authResult.context;

  // 3. Enforce per-token AND per-tenant rate limits
  const rateCheck = await consumeMcpRateLimit(deps.platformDb, {
    grantId: ctx.grantId,
    tenantId: ctx.tenantId,
    policy: deps.rateLimitPolicy,
    nowMs,
  });

  if (!rateCheck.allowed) {
    await appendPlatformAudit(deps.platformDb, {
      actorUserId: ctx.userId,
      actorRole: ctx.memberRole,
      action: "mcp.request.rate_limited",
      targetType: "mcp_grant",
      targetId: ctx.grantId,
      tenantId: ctx.tenantId,
      reason: rateCheck.violatedBucket,
      outcome: "denied",
      requestId,
      metadata: {
        clientId: ctx.clientId,
        violatedBucket: rateCheck.violatedBucket,
        retryAfterSeconds: rateCheck.retryAfterSeconds,
      },
      createdAtMs: nowMs,
    }).catch(() => undefined);

    return jsonRpcResponse(
      429,
      jsonRpcErrorPayload(null, -32029, "Batas permintaan MCP terlampaui. Coba lagi sebentar.", {
        code: "RATE_LIMITED",
        violatedBucket: rateCheck.violatedBucket,
        retryAfterSeconds: rateCheck.retryAfterSeconds,
      }),
      {
        "Retry-After": String(rateCheck.retryAfterSeconds),
        "X-Request-Id": requestId,
      },
    );
  }

  // 4. Parse & validate JSON-RPC 2.0 body (size-bounded)
  const rawBodyText = await request.text();
  if (new TextEncoder().encode(rawBodyText).byteLength > MCP_MAX_REQUEST_BODY_BYTES) {
    return jsonRpcResponse(
      413,
      jsonRpcErrorPayload(null, -32600, "Payload JSON-RPC terlalu besar."),
      { "X-Request-Id": requestId },
    );
  }

  let parsedRaw: unknown;
  try {
    parsedRaw = JSON.parse(rawBodyText);
  } catch {
    return jsonRpcResponse(
      400,
      jsonRpcErrorPayload(null, -32700, "Parse error: isi permintaan bukan JSON yang valid."),
      { "X-Request-Id": requestId },
    );
  }

  const rpcParsed = JsonRpcRequestSchema.safeParse(parsedRaw);
  if (!rpcParsed.success) {
    return jsonRpcResponse(
      400,
      jsonRpcErrorPayload(null, -32600, "Invalid Request: amplop JSON-RPC 2.0 tidak valid."),
      { "X-Request-Id": requestId },
    );
  }

  const rpc = rpcParsed.data;
  const rpcId = rpc.id ?? null;

  // 5. Dispatch MCP protocol methods
  if (rpc.method === "initialize") {
    const requestedVersion =
      typeof rpc.params?.protocolVersion === "string" ? rpc.params.protocolVersion : "";
    const negotiatedVersion = (MCP_SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(
      requestedVersion,
    )
      ? requestedVersion
      : MCP_PROTOCOL_VERSION;

    await appendPlatformAudit(deps.platformDb, {
      actorUserId: ctx.userId,
      actorRole: ctx.memberRole,
      action: "mcp.initialize",
      targetType: "mcp_server",
      targetId: ctx.tenantId,
      tenantId: ctx.tenantId,
      outcome: "success",
      requestId,
      metadata: {
        clientId: ctx.clientId,
        grantId: ctx.grantId,
        protocolVersion: negotiatedVersion,
      },
      createdAtMs: nowMs,
    });

    return jsonRpcResponse(
      200,
      {
        jsonrpc: "2.0",
        id: rpcId,
        result: {
          protocolVersion: negotiatedVersion,
          capabilities: {
            tools: { listChanged: false },
          },
          serverInfo: MCP_SERVER_INFO,
          instructions:
            "Terhubung ke satu situs PunyaSitus. Tool tulis hanya membuat/mengubah draf; publikasi wajib dikonfirmasi pemilik/admin melalui tautan persetujuan browser.",
        },
      },
      {
        "MCP-Protocol-Version": negotiatedVersion,
        "X-Request-Id": requestId,
      },
    );
  }

  if (rpc.method === "notifications/initialized") {
    return new Response(null, {
      status: 202,
      headers: {
        "Cache-Control": "no-store",
        "X-Robots-Tag": "noindex, nofollow",
        "X-Request-Id": requestId,
      },
    });
  }

  if (rpc.method === "ping") {
    return jsonRpcResponse(200, { jsonrpc: "2.0", id: rpcId, result: {} }, { "X-Request-Id": requestId });
  }

  if (rpc.method === "tools/list") {
    const tools = listToolsForGrantedScopes(ctx.scopes, ctx.piiConsentAcked).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      annotations: t.annotations,
    }));

    await appendPlatformAudit(deps.platformDb, {
      actorUserId: ctx.userId,
      actorRole: ctx.memberRole,
      action: "mcp.tools.list",
      targetType: "mcp_server",
      targetId: ctx.tenantId,
      tenantId: ctx.tenantId,
      outcome: "success",
      requestId,
      metadata: {
        clientId: ctx.clientId,
        grantId: ctx.grantId,
        toolCount: tools.length,
      },
      createdAtMs: nowMs,
    });

    return jsonRpcResponse(
      200,
      {
        jsonrpc: "2.0",
        id: rpcId,
        result: { tools },
      },
      { "X-Request-Id": requestId },
    );
  }

  if (rpc.method === "tools/call") {
    const callParsed = McpToolCallParamsSchema.safeParse(rpc.params ?? {});
    if (!callParsed.success) {
      return jsonRpcResponse(
        200,
        jsonRpcErrorPayload(rpcId, -32602, "Parameter tools/call tidak valid."),
        { "X-Request-Id": requestId },
      );
    }

    const { name: toolName, arguments: toolArgs } = callParsed.data;

    // Reject any tool outside the strict allowlist (and explicitly block excluded categories)
    if (!isMcpAllowedToolName(toolName) || isMcpExcludedToolName(toolName)) {
      await appendPlatformAudit(deps.platformDb, {
        actorUserId: ctx.userId,
        actorRole: ctx.memberRole,
        action: "mcp.tool.denied_excluded",
        targetType: "mcp_tool",
        targetId: toolName,
        tenantId: ctx.tenantId,
        outcome: "denied",
        requestId,
        metadata: { clientId: ctx.clientId, grantId: ctx.grantId },
        createdAtMs: nowMs,
      });
      return jsonRpcResponse(
        200,
        jsonRpcErrorPayload(rpcId, -32601, `Tool "${toolName}" tidak tersedia pada server MCP ini.`, {
          code: "TOOL_NOT_ALLOWED",
        }),
        { "X-Request-Id": requestId },
      );
    }

    // Scope enforcement (plus explicit PII ack check for leads:read)
    const requiredScope = MCP_TOOL_REQUIRED_SCOPE[toolName];
    if (!ctx.scopes.has(requiredScope) || (requiredScope === "leads:read" && !ctx.piiConsentAcked)) {
      await appendPlatformAudit(deps.platformDb, {
        actorUserId: ctx.userId,
        actorRole: ctx.memberRole,
        action: "mcp.tool.denied_scope",
        targetType: "mcp_tool",
        targetId: toolName,
        tenantId: ctx.tenantId,
        outcome: "denied",
        requestId,
        metadata: {
          clientId: ctx.clientId,
          grantId: ctx.grantId,
          requiredScope,
        },
        createdAtMs: nowMs,
      });
      return jsonRpcResponse(
        200,
        jsonRpcErrorPayload(
          rpcId,
          -32003,
          `Token tidak memiliki izin scope "${requiredScope}" untuk memanggil tool "${toolName}".`,
          { code: "INSUFFICIENT_SCOPE", requiredScope },
        ),
        { "X-Request-Id": requestId },
      );
    }

    try {
      // Strictly open ONLY the single bound `ctx.tenantId` TenantStore DO!
      const tenantDb = await deps.openTenantDb(ctx.tenantId);
      const data = await executeTenantMcpTool(
        {
          platformDb: deps.platformDb,
          tenantDb,
          adminOrigin: deps.adminOrigin,
          grantId: ctx.grantId,
          clientId: ctx.clientId,
          userId: ctx.userId,
          tenantId: ctx.tenantId,
          organizationId: ctx.organizationId,
          tenantHandle: ctx.tenantHandle,
          tenantName: ctx.tenantName,
          nowMs,
        },
        toolName,
        toolArgs,
      );

      await appendPlatformAudit(deps.platformDb, {
        actorUserId: ctx.userId,
        actorRole: ctx.memberRole,
        action: "mcp.tool.call",
        targetType: "mcp_tool",
        targetId: toolName,
        tenantId: ctx.tenantId,
        outcome: "success",
        requestId,
        metadata: {
          clientId: ctx.clientId,
          grantId: ctx.grantId,
          scope: requiredScope,
        },
        createdAtMs: nowMs,
      });

      return jsonRpcResponse(
        200,
        {
          jsonrpc: "2.0",
          id: rpcId,
          result: {
            content: [{ type: "text", text: JSON.stringify(data) }],
            structuredContent: data,
            isError: false,
          },
        },
        { "X-Request-Id": requestId },
      );
    } catch (err) {
      const SAFE_DOMAIN_ERROR_CODES = new Set([
        "NOT_FOUND",
        "STALE_VERSION",
        "VALIDATION_ERROR",
        "SLUG_CONFLICT",
        "INVALID_ARGUMENTS",
        "LIVE_SLUG_CHANGE_FORBIDDEN_VIA_MCP",
        "HOMEPAGE_ALREADY_SET",
      ]);

      const rawErrCode =
        err instanceof McpToolExecutionError
          ? err.code
          : err instanceof Error && "code" in err && typeof (err as { code?: unknown }).code === "string"
            ? String((err as { code: string }).code)
            : null;
      const isSafeDomainError =
        err instanceof McpToolExecutionError ||
        (rawErrCode !== null && SAFE_DOMAIN_ERROR_CODES.has(rawErrCode));

      const code = isSafeDomainError && rawErrCode ? rawErrCode : "TOOL_EXECUTION_FAILED";
      const message =
        isSafeDomainError && err instanceof Error
          ? err.message
          : "Terjadi kesalahan internal saat menjalankan tool MCP.";

      await appendPlatformAudit(deps.platformDb, {
        actorUserId: ctx.userId,
        actorRole: ctx.memberRole,
        action: "mcp.tool.call",
        targetType: "mcp_tool",
        targetId: toolName,
        tenantId: ctx.tenantId,
        reason: code,
        outcome: "error",
        requestId,
        metadata: {
          clientId: ctx.clientId,
          grantId: ctx.grantId,
          errorCode: code,
        },
        createdAtMs: nowMs,
      }).catch(() => undefined);

      return jsonRpcResponse(
        200,
        {
          jsonrpc: "2.0",
          id: rpcId,
          result: {
            content: [{ type: "text", text: JSON.stringify({ error: code, message }) }],
            isError: true,
          },
        },
        { "X-Request-Id": requestId },
      );
    }
  }

  return jsonRpcResponse(
    200,
    jsonRpcErrorPayload(rpcId, -32601, `Metode JSON-RPC "${rpc.method}" tidak didukung.`),
    { "X-Request-Id": requestId },
  );
}

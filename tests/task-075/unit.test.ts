import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildAuthorizationServerMetadata,
  buildCanonicalMcpResource,
  buildProtectedResourceMetadata,
  computePkceS256Challenge,
  fetchCimdMetadataDocument,
  isMatchingMcpResource,
  isMcpAllowedToolName,
  isMcpExcludedToolName,
  JsonRpcRequestSchema,
  listToolsForGrantedScopes,
  MCP_EXCLUDED_TOOLS,
  McpToolInputSchemas,
  normalizeMcpResourceUrl,
  parseAndNormalizeMcpScopes,
  validateCimdClientIdUrl,
  validateOAuthRedirectUri,
  verifyPkceS256,
  type McpScope,
} from "@punyasitus/core/mcp/index";
import { PLATFORM_0030_MCP_OAUTH_GRANTS_SQL } from "@punyasitus/db/mcp/migrations";

const rootDir = path.resolve(import.meta.dirname, "../..");

describe("TASK-075 unit: migration parity, PKCE S256, RFC 8707, CIMD SSRF, tool surface, and JSON-RPC schemas", () => {
  it("matches packages/db/migrations/platform/0030_mcp_oauth_grants.sql byte-for-byte", () => {
    const onDisk = fs.readFileSync(
      path.join(rootDir, "packages/db/migrations/platform/0030_mcp_oauth_grants.sql"),
      "utf8",
    );
    expect(PLATFORM_0030_MCP_OAUTH_GRANTS_SQL).toBe(onDisk);
  });

  it("computes and verifies RFC 7636 PKCE S256 challenges strictly", async () => {
    // RFC 7636 Appendix B test vector
    const rfcVerifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const expectedChallenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

    const computed = await computePkceS256Challenge(rfcVerifier);
    expect(computed).toBe(expectedChallenge);
    expect(await verifyPkceS256(rfcVerifier, expectedChallenge)).toBe(true);

    // Wrong verifier or malformed length must fail
    expect(await verifyPkceS256(`${rfcVerifier}X`, expectedChallenge)).toBe(false);
    expect(await verifyPkceS256("too-short", expectedChallenge)).toBe(false);
    expect(await verifyPkceS256(rfcVerifier, "invalid-challenge")).toBe(false);
  });

  it("enforces RFC 8707 canonical MCP resource matching", () => {
    const canonical = buildCanonicalMcpResource("https://app.punyasitus.com");
    expect(canonical).toBe("https://app.punyasitus.com/mcp");
    expect(isMatchingMcpResource("https://app.punyasitus.com/mcp", canonical)).toBe(true);
    expect(isMatchingMcpResource("https://app.punyasitus.com/mcp/", canonical)).toBe(true);

    // Missing, wrong host, wrong path, query, or fragment MUST fail
    expect(isMatchingMcpResource("", canonical)).toBe(false);
    expect(isMatchingMcpResource(null, canonical)).toBe(false);
    expect(isMatchingMcpResource("https://evil.example/mcp", canonical)).toBe(false);
    expect(isMatchingMcpResource("https://toko.situsku.click/mcp", canonical)).toBe(false);
    expect(isMatchingMcpResource("https://app.punyasitus.com/other", canonical)).toBe(false);
    expect(isMatchingMcpResource("https://app.punyasitus.com/mcp?x=1", canonical)).toBe(false);
    expect(isMatchingMcpResource("https://app.punyasitus.com/mcp#frag", canonical)).toBe(false);
    expect(normalizeMcpResourceUrl("ftp://app.punyasitus.com/mcp")).toBeNull();
  });

  it("emits RFC 9728 Protected Resource and RFC 8414 Authorization Server metadata", () => {
    const prm = buildProtectedResourceMetadata("https://app.punyasitus.com/");
    expect(prm.resource).toBe("https://app.punyasitus.com/mcp");
    expect(prm.authorization_servers).toEqual(["https://app.punyasitus.com"]);
    expect(prm.bearer_methods_supported).toEqual(["header"]);
    expect(prm.scopes_supported).toEqual([
      "content:read",
      "content:write_draft",
      "content:publish_request",
      "leads:read",
    ]);

    const asm = buildAuthorizationServerMetadata("https://app.punyasitus.com");
    expect(asm.issuer).toBe("https://app.punyasitus.com");
    expect(asm.authorization_endpoint).toBe("https://app.punyasitus.com/oauth2/authorize");
    expect(asm.token_endpoint).toBe("https://app.punyasitus.com/oauth2/token");
    expect(asm.code_challenge_methods_supported).toEqual(["S256"]);
    expect(asm.client_id_metadata_document_supported).toBe(true);
    expect(asm.resource_indicators_supported).toBe(true);
  });

  it("blocks private/loopback/link-local/CGNAT IPs, non-HTTPS, root paths, and redirects for CIMD", async () => {
    const blockedUrls = [
      "http://agent.example/oauth/client.json",
      "https://localhost/oauth/client.json",
      "https://127.0.0.1/oauth/client.json",
      "https://10.0.0.1/oauth/client.json",
      "https://172.16.5.4/oauth/client.json",
      "https://192.168.1.10/oauth/client.json",
      "https://169.254.169.254/latest/meta-data/",
      "https://100.64.0.1/client.json",
      "https://[::1]/client.json",
      "https://[fe80::1]/client.json",
      "https://[fc00::1]/client.json",
      "https://metadata.internal/client.json",
      "https://agent.example/",
      "https://agent.example:8443/client.json",
      "https://user:pass@agent.example/client.json",
      "https://agent.example/client.json#frag",
    ];

    let fetchCalled = false;
    const neverCalledFetch: typeof fetch = async () => {
      fetchCalled = true;
      return new Response("should not be called");
    };

    for (const url of blockedUrls) {
      const check = validateCimdClientIdUrl(url);
      expect(check.ok, `Expected CIMD URL to be rejected: ${url}`).toBe(false);

      const fetched = await fetchCimdMetadataDocument(url, { fetchFn: neverCalledFetch });
      expect(fetched.ok, `Expected CIMD fetch to fail before network: ${url}`).toBe(false);
    }
    expect(fetchCalled).toBe(false);

    // Redirect responses MUST be refused
    const redirectFetch: typeof fetch = async (_input, init) => {
      expect(init?.redirect).toBe("error");
      return new Response(null, {
        status: 302,
        headers: { Location: "https://169.254.169.254/latest/meta-data/" },
      });
    };
    const redirectRes = await fetchCimdMetadataDocument("https://agent.example/oauth/client.json", {
      fetchFn: redirectFetch,
    });
    expect(redirectRes.ok).toBe(false);
    if (!redirectRes.ok) {
      expect(redirectRes.code).toBe("REDIRECT_BLOCKED");
    }

    // Oversized response (>32 KiB) MUST be refused
    const hugeFetch: typeof fetch = async () =>
      new Response("x".repeat(40_000), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    const hugeRes = await fetchCimdMetadataDocument("https://agent.example/oauth/client.json", {
      fetchFn: hugeFetch,
    });
    expect(hugeRes.ok).toBe(false);
    if (!hugeRes.ok) {
      expect(hugeRes.code).toBe("RESPONSE_TOO_LARGE");
    }

    // Mismatched client_id inside document MUST be refused
    const mismatchFetch: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          client_id: "https://other.example/oauth/client.json",
          client_name: "Spoofed Agent",
          redirect_uris: ["https://agent.example/callback"],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    const mismatchRes = await fetchCimdMetadataDocument(
      "https://agent.example/oauth/client.json",
      { fetchFn: mismatchFetch },
    );
    expect(mismatchRes.ok).toBe(false);
    if (!mismatchRes.ok) {
      expect(mismatchRes.code).toBe("CLIENT_ID_MISMATCH");
    }

    // Slow-drip body read MUST be aborted by the shared AbortController timeout
    const slowBodyFetch: typeof fetch = async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"client_id":'));
          // Intentionally never closes to simulate a slow-drip response
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    const slowRes = await fetchCimdMetadataDocument("https://agent.example/oauth/client.json", {
      fetchFn: slowBodyFetch,
      timeoutMs: 250,
    });
    expect(slowRes.ok).toBe(false);
    if (!slowRes.ok) {
      expect(slowRes.code).toBe("FETCH_TIMEOUT");
    }

    // Valid public HTTPS CIMD succeeds
    const validFetch: typeof fetch = async (_input, init) => {
      expect(init?.redirect).toBe("error");
      return new Response(
        JSON.stringify({
          client_id: "https://agent.example/oauth/client.json",
          client_name: "Test AI Assistant",
          client_uri: "https://agent.example",
          redirect_uris: ["https://agent.example/callback", "http://127.0.0.1:4321/cb"],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
    const validRes = await fetchCimdMetadataDocument("https://agent.example/oauth/client.json", {
      fetchFn: validFetch,
    });
    expect(validRes.ok).toBe(true);
    if (validRes.ok) {
      expect(validRes.document.client_name).toBe("Test AI Assistant");
      expect(validRes.document.redirect_uris).toContain("https://agent.example/callback");
    }
  });

  it("validates redirect URIs (public HTTPS + RFC 8252 loopback only)", () => {
    expect(validateOAuthRedirectUri("https://claude.ai/api/mcp/auth_callback").ok).toBe(true);
    expect(validateOAuthRedirectUri("http://127.0.0.1:9999/callback").ok).toBe(true);
    expect(validateOAuthRedirectUri("http://localhost:8080/cb").ok).toBe(true);

    expect(validateOAuthRedirectUri("http://evil.example/cb").ok).toBe(false);
    expect(validateOAuthRedirectUri("https://claude.ai/cb#fragment").ok).toBe(false);
    expect(validateOAuthRedirectUri("javascript:alert(1)").ok).toBe(false);
  });

  it("enforces strict tool allowlist, excludes forbidden tools, and validates scopes + JSON-RPC schemas", () => {
    const allScopes = new Set<McpScope>([
      "content:read",
      "content:write_draft",
      "content:publish_request",
      "leads:read",
    ]);

    const toolsWithoutPii = listToolsForGrantedScopes(allScopes, false).map((t) => t.name);
    expect(toolsWithoutPii).toContain("get_site_overview");
    expect(toolsWithoutPii).toContain("list_pages");
    expect(toolsWithoutPii).toContain("create_page_draft");
    expect(toolsWithoutPii).toContain("request_publish_approval");
    expect(toolsWithoutPii).not.toContain("list_leads");
    expect(toolsWithoutPii).not.toContain("get_lead");

    const toolsWithPii = listToolsForGrantedScopes(allScopes, true).map((t) => t.name);
    expect(toolsWithPii).toContain("list_leads");
    expect(toolsWithPii).toContain("get_lead");

    // Excluded tools MUST NEVER appear and MUST be rejected
    for (const excluded of MCP_EXCLUDED_TOOLS) {
      expect(isMcpAllowedToolName(excluded)).toBe(false);
      expect(isMcpExcludedToolName(excluded)).toBe(true);
      expect(toolsWithPii).not.toContain(excluded);
    }

    // Scope normalization supports both canonical and ADR-0008 shorthand aliases
    const aliasParsed = parseAndNormalizeMcpScopes("content:read content:write content:publish");
    expect(aliasParsed.ok).toBe(true);
    if (aliasParsed.ok) {
      expect(aliasParsed.scopes).toEqual([
        "content:read",
        "content:write_draft",
        "content:publish_request",
      ]);
    }
    expect(parseAndNormalizeMcpScopes("admin:all").ok).toBe(false);

    // JSON-RPC envelope & strict tool schemas reject unknown tenantId selectors
    expect(
      JsonRpcRequestSchema.safeParse({ jsonrpc: "2.0", id: 1, method: "tools/list" }).success,
    ).toBe(true);
    expect(JsonRpcRequestSchema.safeParse({ jsonrpc: "1.0", method: "tools/list" }).success).toBe(
      false,
    );
    expect(
      McpToolInputSchemas.list_pages.safeParse({ status: "draft", tenantId: "other-tenant" })
        .success,
    ).toBe(false);
    expect(
      McpToolInputSchemas.create_page_draft.safeParse({
        title: "Halaman Baru",
        tenant_id: "forged",
      }).success,
    ).toBe(false);
    // confirmSlugChange is strictly removed from MCP draft update schemas
    expect(
      McpToolInputSchemas.update_page_draft.safeParse({
        pageId: 1,
        expectedVersion: 1,
        slug: "baru",
        confirmSlugChange: true,
      }).success,
    ).toBe(false);
    expect(
      McpToolInputSchemas.update_post_draft.safeParse({
        postId: 1,
        expectedVersion: 1,
        slug: "baru",
        confirmSlugChange: true,
      }).success,
    ).toBe(false);
  });
});

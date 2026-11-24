import fs from "node:fs";
import path from "node:path";
import {
  isMcpAllowedToolName,
  isMcpExcludedToolName,
  MCP_ALLOWED_TOOLS,
  MCP_EXCLUDED_TOOLS,
  MCP_TOOL_REQUIRED_SCOPE,
} from "@punyasitus/core/mcp/index";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PLUGIN_REGISTRY,
  REGISTERED_FIRST_PARTY_PLUGINS,
} from "../../apps/web/src/core/plugin-registry.ts";
import {
  classifyRoute,
  compareInventories,
  enumerateAllSurfaces,
  extractHttpMethods,
  INVENTORY_PATH,
  REPO_ROOT,
} from "../../scripts/security/enumerate-surfaces.mjs";

const OFFICIAL_PLUGIN_IDS = [
  "bio-links",
  "lead-notifier",
  "seo-ai-autopilot",
  "wa-cs-rotator",
  "wp-importer",
] as const;

const TENANT_API_AUTH_GUARD_RE =
  /authorize[A-Za-z0-9_]*|resolveAuthorizedTenantMember|handleTenant[A-Za-z0-9_]*|handleDashboard[A-Za-z0-9_]*|handleMedia[A-Za-z0-9_]*|handleSeoVisibilityApiRequest|handleInsightsApiRequest|handleMembersApiRequest|handleAcceptInvitationApiRequest|handleNotificationSettingsApiRequest|handleVideo[A-Za-z0-9_]*|requireTenant|loadMemberTenantEntitlement/;

const CONSOLE_API_AUTH_GUARD_RE =
  /authorizeConsoleRequest|requireActivePlatformOperator|handleConsole[A-Za-z0-9_]*|requireConsole/;

const AGENCY_API_AUTH_GUARD_RE =
  /authorizeAgencyRequest|requireActiveAgencyUser|handleAgency[A-Za-z0-9_]*/;

// Strict affiliate auth guard: requires genuine session/account authorization (never CSRF-only checks)
const AFFILIATE_API_AUTH_GUARD_RE =
  /authorizeAffiliateRequest|enforceSessionLifetimeCeiling|auth\.api\.getSession/;

describe("Cross-Tenant BOLA & Surface Authorization Contract Suite (TASK-078)", () => {
  const actual = enumerateAllSurfaces();

  it("matches docs/security/surface-inventory.json with zero unclassified or drifted surfaces", () => {
    expect(fs.existsSync(INVENTORY_PATH)).toBe(true);
    const recorded = JSON.parse(fs.readFileSync(INVENTORY_PATH, "utf8"));
    const diffs = compareInventories(actual, recorded);
    expect(diffs).toEqual([]);
    expect(actual.summary.totalRoutes).toBeGreaterThanOrEqual(300);
    expect(actual.summary.countsByCategory.tenant_api).toBeGreaterThanOrEqual(100);
    expect(actual.summary.countsByCategory.console_api).toBeGreaterThanOrEqual(40);
    expect(actual.summary.countsByCategory.public_tenant_route).toBeGreaterThanOrEqual(20);
  });

  it("never classifies any /api/** route as public_tenant_route or unclassified_api and detects all HTTP verb export forms", () => {
    const misclassifiedApi = actual.routes.filter(
      (r) =>
        (r.route === "/api" || r.route.startsWith("/api/")) &&
        (r.category === "public_tenant_route" || r.category === "unclassified_api"),
    );
    expect(misclassifiedApi).toEqual([]);

    const anyUnclassified = actual.routes.filter((r) => r.category.includes("unclassified"));
    expect(anyUnclassified).toEqual([]);

    // Verify fail-closed classifier behavior on edge /api paths
    expect(classifyRoute("/api/account/profile", "endpoint").category).toBe("auth_account");
    expect(classifyRoute("/api/tenants", "endpoint").category).toBe("tenant_api");
    expect(classifyRoute("/api/onboarding", "endpoint").category).toBe("onboarding_api");
    expect(classifyRoute("/api/unknown-future-route", "endpoint").category).toBe("unclassified_api");

    // Verify extractor captures all JS/TS export syntaxes
    const syntheticModule = `
      export const GET = () => new Response("ok");
      export function POST() { return new Response("ok"); }
      export async function DELETE() { return new Response("ok"); }
      export { putHandler as PUT, PATCH };
      export { OPTIONS } from "./other.ts";
    `;
    expect(extractHttpMethods(syntheticModule)).toEqual([
      "DELETE",
      "GET",
      "OPTIONS",
      "PATCH",
      "POST",
      "PUT",
    ]);
  });

  it("enforces an explicit tenant authorization guard on 100% of enumerated tenant_api routes", () => {
    const tenantApiRoutes = actual.routes.filter((r) => r.category === "tenant_api");
    expect(tenantApiRoutes.length).toBeGreaterThanOrEqual(100);

    const missingGuards: string[] = [];
    for (const r of tenantApiRoutes) {
      const fullPath = path.join(REPO_ROOT, r.file);
      const src = fs.readFileSync(fullPath, "utf8");
      if (!TENANT_API_AUTH_GUARD_RE.test(src)) {
        missingGuards.push(`${r.route} (${r.file})`);
      }
    }
    expect(missingGuards).toEqual([]);
  });

  it("enforces an explicit platform operator + 2FA guard on 100% of enumerated console_api routes", () => {
    const consoleApiRoutes = actual.routes.filter((r) => r.category === "console_api");
    expect(consoleApiRoutes.length).toBeGreaterThanOrEqual(40);

    const missingGuards: string[] = [];
    for (const r of consoleApiRoutes) {
      const fullPath = path.join(REPO_ROOT, r.file);
      const src = fs.readFileSync(fullPath, "utf8");
      if (!CONSOLE_API_AUTH_GUARD_RE.test(src)) {
        missingGuards.push(`${r.route} (${r.file})`);
      }
    }
    expect(missingGuards).toEqual([]);
  });

  it("enforces explicit agency authorization guards on 100% of enumerated agency_api routes", () => {
    const agencyApiRoutes = actual.routes.filter((r) => r.category === "agency_api");
    expect(agencyApiRoutes.length).toBeGreaterThanOrEqual(10);

    const missingGuards: string[] = [];
    for (const r of agencyApiRoutes) {
      const fullPath = path.join(REPO_ROOT, r.file);
      const src = fs.readFileSync(fullPath, "utf8");
      if (!AGENCY_API_AUTH_GUARD_RE.test(src)) {
        missingGuards.push(`${r.route} (${r.file})`);
      }
    }
    expect(missingGuards).toEqual([]);
  });

  it("enforces real session/account authorization guards (not CSRF-only) on 100% of enumerated affiliate_api routes", () => {
    const affiliateApiRoutes = actual.routes.filter((r) => r.category === "affiliate_api");
    expect(affiliateApiRoutes.length).toBeGreaterThanOrEqual(3);

    const missingGuards: string[] = [];
    for (const r of affiliateApiRoutes) {
      const fullPath = path.join(REPO_ROOT, r.file);
      const src = fs.readFileSync(fullPath, "utf8");
      if (!AFFILIATE_API_AUTH_GUARD_RE.test(src)) {
        missingGuards.push(`${r.route} (${r.file})`);
      }
    }
    expect(missingGuards).toEqual([]);
  });

  it("enumerates all 16 allowed MCP tools with explicit least-privilege scopes and zero excluded tool overlap", () => {
    expect(MCP_ALLOWED_TOOLS.length).toBe(16);
    expect(actual.mcpTools.allowed.length).toBe(MCP_ALLOWED_TOOLS.length);

    for (const tool of MCP_ALLOWED_TOOLS) {
      expect(isMcpAllowedToolName(tool)).toBe(true);
      expect(isMcpExcludedToolName(tool)).toBe(false);
      expect(MCP_TOOL_REQUIRED_SCOPE[tool]).toBeDefined();
    }

    for (const excluded of MCP_EXCLUDED_TOOLS) {
      expect(isMcpAllowedToolName(excluded)).toBe(false);
      expect(isMcpExcludedToolName(excluded)).toBe(true);
    }
  });

  it("registers exactly the 5 official Frozen-Core first-party plugins with scoped table prefixes", () => {
    const registeredIds = REGISTERED_FIRST_PARTY_PLUGINS.map((p) => p.manifest.id).sort();
    expect(registeredIds).toEqual([...OFFICIAL_PLUGIN_IDS]);
    expect(actual.plugins.map((p) => p.id)).toEqual([...OFFICIAL_PLUGIN_IDS]);

    for (const id of OFFICIAL_PLUGIN_IDS) {
      const plugin = DEFAULT_PLUGIN_REGISTRY.get(id);
      expect(plugin).not.toBeNull();
      expect(plugin?.manifest.id).toBe(id);
      for (const migration of plugin?.migrations ?? []) {
        const expectedPrefix = `plg_${id.replace(/-/g, "_")}__`;
        expect(migration.sql.includes(expectedPrefix)).toBe(true);
      }
    }
  });

  it("blocks platform/admin/console/MCP prefixes on tenant hosts in apps/web/src/core/tenant.ts", () => {
    const tenantCoreSrc = fs.readFileSync(
      path.join(REPO_ROOT, "apps/web/src/core/tenant.ts"),
      "utf8",
    );
    for (const prefix of [
      "/dashboard",
      "/agency",
      "/affiliate",
      "/console",
      "/auth",
      "/account",
      "/mcp",
      "/oauth2",
      "/.well-known/oauth-",
      "/api/console",
      "/api/auth",
    ]) {
      expect(tenantCoreSrc).toContain(`"${prefix}"`);
    }
  });
});

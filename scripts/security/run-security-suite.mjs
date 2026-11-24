#!/usr/bin/env node
/* global process, console, URL, Buffer */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  assert,
  createSeededM1Topology,
  httpRequest,
} from "../../tests/e2e-gate/_m1-harness.mjs";

/**
 * Unified Security Assurance Runner & Built-Worker HTTP DAST Scanner (`TASK-078`, `REQ-078`).
 *
 * Stages:
 *  1. Surface enumeration drift check (`scripts/security/enumerate-surfaces.mjs --check`)
 *  2. Automated security & TASK-078 unit + `workerd` BOLA integration suites (unless `--skip-vitest`)
 *  3. Live HTTP DAST, Security Header Audit, & Cross-Tenant Isolation Probes against the real
 *     built `@punyasitus/web` Cloudflare Worker (`apps/web/dist/server/wrangler.json`)
 *  4. Optional OWASP ZAP Docker Baseline scan when `ghcr.io/zaproxy/zaproxy:stable` is available
 *     locally (or `--pull-zap` is explicitly passed); otherwise records honest status while
 *     CI runs `zaproxy/action-baseline@v0.15.0` via `.github/workflows/security.yml`.
 */

export const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

function parseCliArgs(argv) {
  const args = {
    skipVitest: false,
    skipDast: false,
    pullZap: false,
    reportOut: null,
    jsonOnly: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--skip-vitest") {
      args.skipVitest = true;
    } else if (token === "--skip-dast") {
      args.skipDast = true;
    } else if (token === "--pull-zap") {
      args.pullZap = true;
    } else if (token === "--report-out" && argv[i + 1]) {
      args.reportOut = path.resolve(argv[++i]);
    } else if (token === "--json") {
      args.jsonOnly = true;
    } else if (token === "--help" || token === "-h") {
      console.log(
        "Usage: node scripts/security/run-security-suite.mjs [--skip-vitest] [--skip-dast] [--pull-zap] [--report-out <path>] [--json]",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${token}`);
    }
  }
  return args;
}

function runCheckedCommand(label, cmd, cmdArgs) {
  const started = Date.now();
  const res = spawnSync(cmd, cmdArgs, {
    cwd: REPO_ROOT,
    stdio: "inherit",
    env: { ...process.env, CI: "true" },
  });
  const durationMs = Date.now() - started;
  if (res.status !== 0) {
    throw new Error(`${label} failed with exit code ${res.status ?? 1}`);
  }
  return { ok: true, label, durationMs };
}

function inspectDockerZapAvailability() {
  const info = spawnSync("docker", ["info"], { encoding: "utf8" });
  if (info.status !== 0) {
    return { dockerAvailable: false, zapImageCached: false };
  }
  const img = spawnSync("docker", ["image", "inspect", "ghcr.io/zaproxy/zaproxy:stable"], {
    encoding: "utf8",
  });
  return { dockerAvailable: true, zapImageCached: img.status === 0 };
}

function hasUnsafeInlineScriptSrc(cspHeader) {
  const directives = new Map();
  for (const rawPart of String(cspHeader).split(";")) {
    const part = rawPart.trim();
    if (!part) continue;
    const spaceIdx = part.search(/\s/);
    if (spaceIdx === -1) {
      directives.set(part.toLowerCase(), "");
    } else {
      directives.set(part.slice(0, spaceIdx).toLowerCase(), part.slice(spaceIdx + 1));
    }
  }
  const scriptSrc = directives.get("script-src") ?? directives.get("default-src") ?? "";
  const scriptSrcElem = directives.get("script-src-elem") ?? "";
  const unsafeInlineRe = /(?:^|\s)'unsafe-inline'(?:\s|$)/i;
  return unsafeInlineRe.test(scriptSrc) || unsafeInlineRe.test(scriptSrcElem);
}

function summarizeHeaders(headers) {
  const pick = (name) => {
    const val = headers[name.toLowerCase()];
    return Array.isArray(val) ? val.join(", ") : (val ?? null);
  };
  return {
    contentSecurityPolicy: pick("content-security-policy"),
    xContentTypeOptions: pick("x-content-type-options"),
    xFrameOptions: pick("x-frame-options"),
    referrerPolicy: pick("referrer-policy"),
    strictTransportSecurity: pick("strict-transport-security"),
    permissionsPolicy: pick("permissions-policy"),
    cacheControl: pick("cache-control"),
    xRobotsTag: pick("x-robots-tag"),
    accessControlAllowOrigin: pick("access-control-allow-origin"),
    accessControlAllowCredentials: pick("access-control-allow-credentials"),
    server: pick("server"),
    xPoweredBy: pick("x-powered-by"),
  };
}

export async function runBuiltWorkerDastScan({ pullZap = false } = {}) {
  const topology = await createSeededM1Topology({ prefix: "sec-dast", withSecondTenant: true });
  const observedAlerts = [];
  const probes = {};

  try {
    const { port, tenantA, tenantB, seeded } = topology;
    const adminOrigin = `http://127.0.0.1:${port}`;
    const adminJsonHeaders = (cookie, origin = adminOrigin) => ({
      "Content-Type": "application/json",
      Origin: origin,
      Cookie: cookie,
    });

    // Seed a unique published page on Tenant B so public host isolation can be proven bidirectionally
    const bPageCreate = await httpRequest(port, `/api/tenants/${tenantB.handle}/pages`, {
      method: "POST",
      headers: adminJsonHeaders(tenantB.cookie),
      body: JSON.stringify({
        title: "Halaman Rahasia CV Beta Karya Mandiri",
        slug: "halaman-rahasia-beta-only",
        isHomepage: false,
        layoutMode: "standard",
        sections: [
          {
            id: "hero-beta-only",
            kind: "hero",
            heading: "Konten Eksklusif Tenant Beta",
            subheading: "Tidak boleh pernah muncul di host Tenant Alpha.",
            bodyHtml: null,
          },
        ],
      }),
    });
    assert(
      bPageCreate.status === 201,
      `Failed creating Tenant B probe page: status=${bPageCreate.status} body=${bPageCreate.body.slice(0, 300)}`,
    );
    const bPageJson = JSON.parse(bPageCreate.body);
    const bPageId = bPageJson.page?.id ?? bPageJson.data?.id ?? bPageJson.id;
    const bPageVersion = bPageJson.page?.version ?? bPageJson.data?.version ?? 1;
    const bPagePub = await httpRequest(
      port,
      `/api/tenants/${tenantB.handle}/pages/${bPageId}/publish`,
      {
        method: "POST",
        headers: adminJsonHeaders(tenantB.cookie),
        body: JSON.stringify({ expectedVersion: bPageVersion }),
      },
    );
    assert(bPagePub.status === 200, `Failed publishing Tenant B probe page: ${bPagePub.status}`);

    // =========================================================================
    // 1. Security Header Audit across Surfaces (Marketing, Auth/App, Tenant, 404, API)
    // =========================================================================
    const headerTargets = [
      { id: "marketing_home", path: "/marketing", headers: {} },
      { id: "auth_login", path: "/auth/login", headers: {} },
      { id: "tenant_home", path: "/", headers: { Host: tenantA.host } },
      { id: "tenant_not_found", path: "/__nonexistent_sec_probe__", headers: { Host: tenantA.host } },
      { id: "api_health", path: "/api/health", headers: {} },
      {
        id: "api_tenant_pages",
        path: `/api/tenants/${tenantA.handle}/pages`,
        headers: { Cookie: tenantA.cookie },
      },
    ];

    const headerAudit = {};
    for (const t of headerTargets) {
      const res = await httpRequest(port, t.path, { method: "GET", headers: t.headers });
      const summary = summarizeHeaders(res.headers);
      headerAudit[t.id] = { status: res.status, headers: summary };

      // Check CORS wildcard + credentials anti-pattern (CRITICAL if present)
      assert(
        !(
          summary.accessControlAllowOrigin === "*" &&
          summary.accessControlAllowCredentials === "true"
        ),
        `Dangerous CORS wildcard with credentials on ${t.id}`,
      );

      // Record honest DAST alerts matching OWASP ZAP baseline rules
      if (t.id === "marketing_home" || t.id === "auth_login" || t.id === "tenant_home") {
        if (!summary.contentSecurityPolicy) {
          observedAlerts.push({
            zapRuleId: "10038",
            severity: "Medium",
            title: "Content Security Policy (CSP) Header Not Set",
            surface: t.id,
            findingRef: "SEC-003",
            disposition: "REOPEN_OWNING_TASK",
            detail: `HTML response on ${t.id} (${t.path}) did not emit Content-Security-Policy.`,
          });
        } else if (hasUnsafeInlineScriptSrc(summary.contentSecurityPolicy)) {
          observedAlerts.push({
            zapRuleId: "10055",
            severity: "Medium",
            title: "CSP: script-src unsafe-inline",
            surface: t.id,
            findingRef: "SEC-006",
            disposition: "REOPEN_OWNING_TASK",
            detail: `CSP on ${t.id} (${t.path}) includes 'unsafe-inline' in script-src.`,
          });
        }

        if (!summary.xContentTypeOptions) {
          observedAlerts.push({
            zapRuleId: "10021",
            severity: "Low",
            title: "X-Content-Type-Options Header Missing",
            surface: t.id,
            findingRef: "SEC-003",
            disposition: "REOPEN_OWNING_TASK",
            detail: `Response on ${t.id} (${t.path}) did not emit X-Content-Type-Options: nosniff.`,
          });
        }

        if (
          !summary.xFrameOptions &&
          !(summary.contentSecurityPolicy && summary.contentSecurityPolicy.includes("frame-ancestors"))
        ) {
          observedAlerts.push({
            zapRuleId: "10020",
            severity: "Medium",
            title: "Missing Anti-clickjacking Header (X-Frame-Options / frame-ancestors)",
            surface: t.id,
            findingRef: "SEC-003",
            disposition: "REOPEN_OWNING_TASK",
            detail: `Response on ${t.id} (${t.path}) omitted both X-Frame-Options and CSP frame-ancestors.`,
          });
        }

        if (!summary.referrerPolicy) {
          observedAlerts.push({
            zapRuleId: "CUSTOM-REFERRER-POLICY",
            severity: "Low",
            title: "Referrer-Policy Header Missing",
            surface: t.id,
            findingRef: "SEC-003",
            disposition: "REOPEN_OWNING_TASK",
            detail: `Response on ${t.id} (${t.path}) did not emit Referrer-Policy.`,
          });
        }
      } else if (t.id === "api_health" || t.id === "api_tenant_pages") {
        if (!summary.xContentTypeOptions) {
          observedAlerts.push({
            zapRuleId: "10021",
            severity: "Low",
            title: "X-Content-Type-Options Header Missing",
            surface: t.id,
            findingRef: "SEC-003",
            disposition: "REOPEN_OWNING_TASK",
            detail: `JSON API response on ${t.id} (${t.path}) did not emit X-Content-Type-Options: nosniff.`,
          });
        }
      }
    }
    probes.headerAudit = headerAudit;

    // =========================================================================
    // 2. Session Cookie Security Attributes (`__Host-ps_session`)
    // =========================================================================
    const signInProbe = await httpRequest(port, "/api/auth/sign-in/email", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: adminOrigin,
      },
      body: JSON.stringify({
        email: tenantA.email,
        password: "M1GateOwnerPassword!234",
      }),
    });
    assert(signInProbe.status === 200, `Expected 200 on sign-in probe, got ${signInProbe.status}`);
    const setCookies = Array.isArray(signInProbe.headers["set-cookie"])
      ? signInProbe.headers["set-cookie"]
      : signInProbe.headers["set-cookie"]
        ? [signInProbe.headers["set-cookie"]]
        : [];
    const sessionSetCookie = setCookies.find((c) => c.startsWith("__Host-ps_session="));
    assert(Boolean(sessionSetCookie), "Expected __Host-ps_session Set-Cookie header on sign-in");
    const lowerCookie = sessionSetCookie.toLowerCase();
    assert(lowerCookie.includes("httponly"), "Session cookie missing HttpOnly");
    assert(lowerCookie.includes("secure"), "Session cookie missing Secure");
    assert(lowerCookie.includes("path=/"), "Session cookie missing Path=/");
    assert(lowerCookie.includes("samesite=lax"), "Session cookie missing SameSite=Lax");
    assert(!lowerCookie.includes("domain="), "Session cookie MUST NOT have Domain= attribute");
    probes.sessionCookieFlags = {
      ok: true,
      cookieName: "__Host-ps_session",
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      pathRoot: true,
      noDomainAttr: true,
    };

    // =========================================================================
    // 3. Exhaustive Live HTTP Cross-Tenant A -> B BOLA Probes on Built Worker
    // =========================================================================
    const crossTenantEndpoints = [
      { name: "pages", method: "GET", path: `/api/tenants/${tenantB.handle}/pages` },
      { name: "pages_by_id", method: "GET", path: `/api/tenants/${tenantB.tenantId}/pages/${bPageId}` },
      { name: "posts", method: "GET", path: `/api/tenants/${tenantB.handle}/posts` },
      { name: "catalog", method: "GET", path: `/api/tenants/${tenantB.handle}/catalog` },
      { name: "leads", method: "GET", path: `/api/tenants/${tenantB.handle}/leads` },
      { name: "leads_export", method: "GET", path: `/api/tenants/${tenantB.handle}/leads/export` },
      { name: "media", method: "GET", path: `/api/tenants/${tenantB.handle}/media` },
      { name: "branches", method: "GET", path: `/api/tenants/${tenantB.handle}/branches` },
      { name: "outlets", method: "GET", path: `/api/tenants/${tenantB.handle}/outlets` },
      { name: "menus", method: "GET", path: `/api/tenants/${tenantB.handle}/menus` },
      { name: "forms", method: "GET", path: `/api/tenants/${tenantB.handle}/forms` },
      { name: "themes", method: "GET", path: `/api/tenants/${tenantB.handle}/themes` },
      { name: "theme", method: "GET", path: `/api/tenants/${tenantB.handle}/theme` },
      { name: "plugins", method: "GET", path: `/api/tenants/${tenantB.handle}/plugins` },
      { name: "plugin_seo_subpath", method: "GET", path: `/api/tenants/${tenantB.handle}/plugins/seo-ai-autopilot/status` },
      { name: "plugin_bio_links_subpath", method: "GET", path: `/api/tenants/${tenantB.handle}/plugins/bio-links/config` },
      { name: "plugin_wa_rotator_subpath", method: "GET", path: `/api/tenants/${tenantB.handle}/plugins/wa-cs-rotator/agents` },
      { name: "plugin_wp_importer_subpath", method: "GET", path: `/api/tenants/${tenantB.handle}/plugins/wp-importer/jobs` },
      { name: "plugin_lead_notifier_subpath", method: "GET", path: `/api/tenants/${tenantB.handle}/plugins/lead-notifier/config` },
      { name: "settings", method: "GET", path: `/api/tenants/${tenantB.handle}/settings` },
      { name: "identity", method: "GET", path: `/api/tenants/${tenantB.handle}/identity` },
      { name: "domains", method: "GET", path: `/api/tenants/${tenantB.handle}/domains` },
      { name: "billing", method: "GET", path: `/api/tenants/${tenantB.handle}/billing` },
      { name: "billing_receipts", method: "GET", path: `/api/tenants/${tenantB.handle}/billing/receipts` },
      { name: "ai_writing_quota", method: "GET", path: `/api/tenants/${tenantB.handle}/ai-writing/quota` },
      { name: "analytics", method: "GET", path: `/api/tenants/${tenantB.handle}/analytics` },
      { name: "seo_settings", method: "GET", path: `/api/tenants/${tenantB.handle}/seo/settings` },
      { name: "revisions", method: "GET", path: `/api/tenants/${tenantB.handle}/revisions` },
      { name: "presets", method: "GET", path: `/api/tenants/${tenantB.handle}/presets` },
      { name: "activity", method: "GET", path: `/api/tenants/${tenantB.handle}/activity` },
      { name: "exports", method: "GET", path: `/api/tenants/${tenantB.handle}/exports` },
      { name: "deletion", method: "GET", path: `/api/tenants/${tenantB.handle}/deletion` },
      { name: "qr", method: "GET", path: `/api/tenants/${tenantB.handle}/qr` },
      { name: "service_requests", method: "GET", path: `/api/tenants/${tenantB.handle}/service-requests` },
      { name: "dashboard_insights_api", method: "GET", path: `/dashboard/${tenantB.handle}/insights/api` },
      { name: "dashboard_seo_api", method: "GET", path: `/dashboard/${tenantB.handle}/seo/api` },
      { name: "dashboard_members_api", method: "GET", path: `/dashboard/${tenantB.handle}/settings/members/api` },
      { name: "dashboard_notifications_api", method: "GET", path: `/dashboard/${tenantB.handle}/settings/notifications/api` },
      { name: "dashboard_onboarding_api", method: "GET", path: `/dashboard/${tenantB.handle}/onboarding/api` },
      { name: "dashboard_services_api", method: "GET", path: `/dashboard/${tenantB.handle}/catalog/services/api` },
      { name: "dashboard_travel_api", method: "GET", path: `/dashboard/${tenantB.handle}/catalog/travel/api` },
      { name: "dashboard_vehicles_api", method: "GET", path: `/dashboard/${tenantB.handle}/catalog/vehicles/api` },
      { name: "dashboard_page_root", method: "GET", path: `/dashboard/${tenantB.handle}` },
    ];

    const bolaResults = [];
    for (const ep of crossTenantEndpoints) {
      const res = await httpRequest(port, ep.path, {
        method: ep.method,
        headers: { Cookie: tenantA.cookie },
      });
      assert(
        res.status === 403 || res.status === 404,
        `BOLA FAILURE on ${ep.name} (${ep.path}): expected 403/404, got ${res.status}`,
      );
      assert(
        !res.body.includes("Beta Karya") && !res.body.includes("halaman-rahasia-beta-only"),
        `DATA LEAK on ${ep.name} (${ep.path}): Tenant B content found in denied response!`,
      );
      bolaResults.push({ name: ep.name, status: res.status });
    }

    // Console & Agency & Affiliate isolation for non-privileged Tenant A owner
    const privilegedEndpoints = [
      { name: "console_tenants", path: "/api/console/tenants" },
      { name: "console_audit", path: "/api/console/audit" },
      { name: "console_affiliates", path: "/api/console/affiliates" },
      { name: "console_settings", path: "/api/console/settings" },
      { name: "agency_overview", path: "/api/agency" },
      { name: "agency_clients", path: "/api/agency/clients" },
      { name: "affiliate_overview", path: "/api/affiliate/overview" },
    ];
    for (const ep of privilegedEndpoints) {
      const res = await httpRequest(port, ep.path, {
        method: "GET",
        headers: { Cookie: tenantA.cookie },
      });
      assert(
        res.status === 401 || res.status === 403 || res.status === 404,
        `PRIVILEGE ESCALATION on ${ep.name} (${ep.path}): expected 401/403/404, got ${res.status}`,
      );
      bolaResults.push({ name: ep.name, status: res.status });
    }
    probes.crossTenantAndPrivilegeIsolation = {
      ok: true,
      testedEndpoints: bolaResults.length,
      allDeniedWithoutLeak: true,
    };

    // =========================================================================
    // 4. Public Host Isolation & Platform Prefix Blocking on Tenant Hosts
    // =========================================================================
    const bOwnPage = await httpRequest(port, "/halaman-rahasia-beta-only", {
      headers: { Host: tenantB.host },
    });
    assert(bOwnPage.status === 200, `Tenant B own published page expected 200, got ${bOwnPage.status}`);

    const aReadingBSlug = await httpRequest(port, "/halaman-rahasia-beta-only", {
      headers: { Host: tenantA.host },
    });
    assert(aReadingBSlug.status === 404, `Tenant A reading Tenant B slug expected 404, got ${aReadingBSlug.status}`);
    assert(!aReadingBSlug.body.includes("Tenant Beta"), "Public host leak A -> B!");

    const bReadingASlug = await httpRequest(port, seeded.articlePath, {
      headers: { Host: tenantB.host },
    });
    assert(bReadingASlug.status === 404, `Tenant B reading Tenant A blog expected 404, got ${bReadingASlug.status}`);
    assert(!bReadingASlug.body.includes("Audit Energi"), "Public host leak B -> A!");

    const platformPathsOnTenantHost = [
      `/dashboard/${tenantA.handle}`,
      "/console",
      "/api/console/tenants",
      "/mcp",
      "/oauth2/token",
      "/.well-known/oauth-authorization-server",
    ];
    for (const p of platformPathsOnTenantHost) {
      const res = await httpRequest(port, p, { headers: { Host: tenantA.host } });
      assert(res.status === 404, `Platform path ${p} on tenant host MUST be 404, got ${res.status}`);
    }
    probes.publicHostIsolation = {
      ok: true,
      tenantAToBSlugStatus: aReadingBSlug.status,
      tenantBToASlugStatus: bReadingASlug.status,
      blockedPlatformPathsCount: platformPathsOnTenantHost.length,
    };

    // =========================================================================
    // 5. Dynamic DAST Attack Probes (XSS, Host/Header Spoofing, Traversal, Dotfiles,
    //    Open Redirect, Method Tampering, CSRF, MCP Bearer-Only)
    // =========================================================================
    // 5a. Reflected XSS probe
    const xssPayload = '"><script>alert(1337)</script>';
    const xssRes = await httpRequest(
      port,
      `/marketing?q=${encodeURIComponent(xssPayload)}`,
      { method: "GET" },
    );
    assert(
      !xssRes.body.includes("<script>alert(1337)</script>"),
      "Reflected unescaped XSS payload detected on /marketing!",
    );

    // 5b. X-Forwarded-Host / X-Tenant-ID spoofing
    const spoofRes = await httpRequest(port, "/halaman-rahasia-beta-only", {
      method: "GET",
      headers: {
        Host: tenantA.host,
        "X-Forwarded-Host": tenantB.host,
        "X-Tenant-ID": tenantB.tenantId,
      },
    });
    assert(
      spoofRes.status === 404 && !spoofRes.body.includes("Tenant Beta"),
      `X-Forwarded-Host / X-Tenant-ID spoofing succeeded: status=${spoofRes.status}`,
    );

    // 5c. Percent-encoding & path-traversal bypass probes
    const bypassPaths = [
      "/api/%63onsole/tenants",
      "/api//console/tenants",
      "/api/console/../tenants",
      "/..%2f.env",
      "/.env",
      "/.git/config",
      "/wp-login.php",
    ];
    const bypassStatuses = {};
    for (const bp of bypassPaths) {
      const res = await httpRequest(port, bp, {
        method: "GET",
        headers: { Cookie: tenantA.cookie },
      });
      assert(
        res.status === 400 || res.status === 401 || res.status === 403 || res.status === 404,
        `Path bypass/dotfile probe ${bp} returned unexpected status ${res.status}`,
      );
      bypassStatuses[bp] = res.status;
    }

    // 5d. Open Redirect probe
    const openRedirectRes = await httpRequest(
      port,
      `/auth/login?next=${encodeURIComponent("https://evil.example/phish")}`,
      { method: "GET" },
    );
    const redirectLoc = String(openRedirectRes.headers.location ?? "");
    assert(
      !redirectLoc.startsWith("https://evil.example") && !redirectLoc.startsWith("//evil.example"),
      `Open redirect vulnerability detected: Location=${redirectLoc}`,
    );

    // 5e. Method tampering probe
    const traceRes = await httpRequest(port, "/api/health", { method: "TRACE" });
    const postAuditRes = await httpRequest(port, "/api/console/audit", {
      method: "POST",
      headers: adminJsonHeaders(tenantA.cookie),
      body: JSON.stringify({}),
    });
    assert(
      postAuditRes.status === 401 || postAuditRes.status === 403 || postAuditRes.status === 405,
      `POST /api/console/audit returned unexpected status ${postAuditRes.status}`,
    );

    // 5f. CSRF / Evil Origin & Missing Origin & Non-JSON Content-Type
    const evilOriginRes = await httpRequest(port, `/api/tenants/${tenantA.handle}/pages`, {
      method: "POST",
      headers: adminJsonHeaders(tenantA.cookie, "https://attacker.example"),
      body: JSON.stringify({ title: "CSRF", slug: "csrf-test", sections: [] }),
    });
    assert(evilOriginRes.status === 403, `Expected 403 on evil Origin, got ${evilOriginRes.status}`);

    const missingOriginRes = await httpRequest(port, `/api/tenants/${tenantA.handle}/pages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: tenantA.cookie,
      },
      body: JSON.stringify({ title: "CSRF No Origin", slug: "csrf-no-origin", sections: [] }),
    });
    assert(
      missingOriginRes.status === 403,
      `Expected 403 on missing Origin, got ${missingOriginRes.status}`,
    );

    // 5g. MCP Bearer-Only boundary (session cookies MUST be rejected on /mcp)
    const mcpCookieRes = await httpRequest(port, "/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: tenantA.cookie,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert(
      mcpCookieRes.status === 401,
      `MCP endpoint MUST reject __Host- session cookies with 401, got ${mcpCookieRes.status}`,
    );

    probes.dastAttackProbes = {
      ok: true,
      reflectedXssNeutralized: true,
      hostSpoofingBlocked: true,
      bypassAndDotfileStatuses: bypassStatuses,
      openRedirectBlocked: true,
      traceMethodStatus: traceRes.status,
      auditMutationBlockedStatus: postAuditRes.status,
      csrfEvilOriginStatus: evilOriginRes.status,
      csrfMissingOriginStatus: missingOriginRes.status,
      mcpCookieRejectedStatus: mcpCookieRes.status,
    };

    // =========================================================================
    // 6. Optional Local OWASP ZAP Docker Baseline (if image cached or --pull-zap)
    // =========================================================================
    const dockerStatus = inspectDockerZapAvailability();
    let zapDocker = {
      executed: false,
      dockerAvailable: dockerStatus.dockerAvailable,
      zapImageCached: dockerStatus.zapImageCached,
      status: dockerStatus.dockerAvailable
        ? "image_not_cached_locally_dast_probe_executed"
        : "docker_unavailable_dast_probe_executed",
      ciWorkflow: ".github/workflows/security.yml (zaproxy/action-baseline@v0.15.0)",
      stagingFullScanStatus: "UNVERIFIED_STAGING_GATE (EXT-10)",
    };

    if (dockerStatus.dockerAvailable && (dockerStatus.zapImageCached || pullZap)) {
      const zapRes = spawnSync(
        "docker",
        [
          "run",
          "--rm",
          "--network",
          "host",
          "-v",
          `${REPO_ROOT}:/zap/wrk:ro`,
          "ghcr.io/zaproxy/zaproxy:stable",
          "zap-baseline.py",
          "-t",
          `http://127.0.0.1:${port}/marketing`,
          "-c",
          "scripts/security/zap-rules.tsv",
          "-I",
        ],
        { encoding: "utf8", timeout: 180_000 },
      );
      zapDocker = {
        ...zapDocker,
        executed: true,
        exitCode: zapRes.status,
        status: zapRes.status === 0 || zapRes.status === 2 ? "completed" : "failed",
        outputTail: `${zapRes.stdout ?? ""}\n${zapRes.stderr ?? ""}`.slice(-2000),
      };
      if (zapDocker.status === "failed") {
        throw new Error(
          `Local OWASP ZAP Docker baseline failed (exit=${zapRes.status ?? "null"}):\n${zapDocker.outputTail}`,
        );
      }
    }

    return {
      ok: true,
      task: "TASK-078",
      verifiedAt: new Date().toISOString(),
      target: `http://127.0.0.1:${port} (built apps/web/dist/server/wrangler.json)`,
      probes,
      observedAlerts,
      zapDocker,
    };
  } finally {
    await topology.cleanup();
  }
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const stages = [];

  // Stage 1: Surface Enumeration Drift Check
  stages.push(
    runCheckedCommand("Surface Enumeration Drift Check", "node", [
      "scripts/security/enumerate-surfaces.mjs",
      "--check",
    ]),
  );

  // Stage 2: Automated Security Unit & Workerd BOLA Integration Tests
  if (!args.skipVitest) {
    stages.push(
      runCheckedCommand("Security & TASK-078 Unit Tests", "pnpm", [
        "exec",
        "vitest",
        "run",
        "--config",
        "tests/setup/vitest.unit.config.ts",
        "--testTimeout=20000",
        "tests/task-078/unit.test.ts",
        "tests/security/cross-tenant-bola.unit.test.ts",
      ]),
    );
    stages.push(
      runCheckedCommand("Cross-Tenant BOLA Workerd Integration Tests", "pnpm", [
        "exec",
        "vitest",
        "run",
        "--config",
        "tests/setup/vitest.integration.config.ts",
        "tests/task-078/workerd.integration.test.ts",
        "tests/security/workerd.bola.integration.test.ts",
      ]),
    );
  }

  // Stage 3: Live Built-Worker HTTP DAST & Isolation Probes
  let dast = null;
  if (!args.skipDast) {
    dast = await runBuiltWorkerDastScan({ pullZap: args.pullZap });
    stages.push({ ok: true, label: "Built-Worker HTTP DAST & Cross-Tenant Probes" });
  }

  const observedAlerts = dast?.observedAlerts ?? [];
  const highOrMediumCount = observedAlerts.filter(
    (a) => a.severity === "High" || a.severity === "Medium",
  ).length;
  const verdict = highOrMediumCount > 0 ? "PASS_WITH_TRACKED_FINDINGS" : "PASS";

  const report = {
    ok: true,
    verdict,
    suite: "PUNYASITUS_PRELAUNCH_SECURITY_ASSURANCE",
    task: "TASK-078",
    requirement: "REQ-078",
    verifiedAt: new Date().toISOString(),
    stages,
    dast,
  };

  if (args.reportOut) {
    fs.mkdirSync(path.dirname(args.reportOut), { recursive: true });
    fs.writeFileSync(args.reportOut, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }

  if (args.jsonOnly) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const alertCount = observedAlerts.length;
    console.log(
      alertCount === 0
        ? `${verdict}: TASK-078 Security Assurance Suite (${stages.length} stages passed; 0 DAST header/CSP alerts [0 High, 0 Medium, 0 Low]).`
        : `${verdict}: TASK-078 Security Assurance Suite (${stages.length} stages passed; ${alertCount} tracked DAST header/CSP alerts [${highOrMediumCount} Medium/High] recorded for owning-task reopen).`,
    );
    if (dast) {
      console.log(
        JSON.stringify(
          {
            testedCrossTenantEndpoints: dast.probes.crossTenantAndPrivilegeIsolation.testedEndpoints,
            publicHostIsolation: dast.probes.publicHostIsolation,
            dastAttackProbes: dast.probes.dastAttackProbes,
            observedAlertCount: alertCount,
            zapDockerStatus: dast.zapDocker.status,
          },
          null,
          2,
        ),
      );
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exit(1);
  });
}

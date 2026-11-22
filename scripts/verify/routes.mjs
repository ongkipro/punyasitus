#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_ROOT = path.resolve(import.meta.dirname, "../..");

const SECRET_VALUE_PATTERNS = [
  { name: "turnstile-live-key", re: /\b0x4[A-Za-z0-9_-]{16,}\b/ },
  { name: "private-key-pem", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "resend-api-key", re: /\bre_[A-Za-z0-9_]{16,}\b/ },
  { name: "stripe-live-key", re: /\b(?:sk|pk)_live_[A-Za-z0-9]{12,}\b/ },
  { name: "cloudflare-bearer-token", re: /\bBearer\s+[A-Za-z0-9._-]{20,}\b/i },
  { name: "github-pat", re: /\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b/ },
];

const ENV_VAR_NAME_RE = /^[A-Z][A-Z0-9_]{2,63}$/;

// Strips single-line and block comments from JSONC without mutating string literals
// such as wildcard route patterns or HTTPS URLs.
export function stripJsoncComments(input) {
  let out = "";
  let inString = false;
  let escaped = false;
  let i = 0;

  while (i < input.length) {
    const ch = input[i];
    const next = input[i + 1];

    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      i += 1;
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }

    if (ch === "/" && next === "/") {
      i += 2;
      while (i < input.length && input[i] !== "\n") {
        i += 1;
      }
      continue;
    }

    if (ch === "/" && next === "*") {
      i += 2;
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) {
        i += 1;
      }
      i += 2;
      continue;
    }

    out += ch;
    i += 1;
  }

  return out;
}

function walkStrings(value, pathParts, visitor) {
  if (typeof value === "string") {
    visitor(value, pathParts.join("."));
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, idx) => walkStrings(item, [...pathParts, String(idx)], visitor));
    return;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      walkStrings(v, [...pathParts, k], visitor);
    }
  }
}

export function validateTopologyConfig(rootDir = DEFAULT_ROOT) {
  const errors = [];
  const checks = [];

  const wranglerPath = path.join(rootDir, "apps/web/wrangler.jsonc");
  const topologyPath = path.join(rootDir, "infra/cloudflare/topology.json");

  if (!fs.existsSync(wranglerPath)) {
    errors.push(`Missing ${wranglerPath}`);
    return { ok: false, checksPassed: 0, errors };
  }
  if (!fs.existsSync(topologyPath)) {
    errors.push(`Missing ${topologyPath}`);
    return { ok: false, checksPassed: 0, errors };
  }

  let wrangler;
  try {
    wrangler = JSON.parse(stripJsoncComments(fs.readFileSync(wranglerPath, "utf8")));
  } catch (err) {
    errors.push(`Failed to parse apps/web/wrangler.jsonc: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, checksPassed: 0, errors };
  }

  let topology;
  try {
    topology = JSON.parse(fs.readFileSync(topologyPath, "utf8"));
  } catch (err) {
    errors.push(`Failed to parse infra/cloudflare/topology.json: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, checksPassed: 0, errors };
  }

  const assertCheck = (name, condition, failureMessage) => {
    if (condition) {
      checks.push(name);
    } else {
      errors.push(`${name}: ${failureMessage}`);
    }
  };

  // 1. Wrangler configuration invariants
  assertCheck(
    "wrangler.worker_prefix",
    typeof wrangler.name === "string" && wrangler.name.startsWith("punyasitus-"),
    `Expected wrangler.name to start with "punyasitus-", got ${JSON.stringify(wrangler.name)}`,
  );
  assertCheck(
    "wrangler.workers_dev_disabled",
    wrangler.workers_dev === false,
    `Expected wrangler.workers_dev === false, got ${JSON.stringify(wrangler.workers_dev)}`,
  );
  assertCheck(
    "wrangler.preview_urls_disabled",
    wrangler.preview_urls === false,
    `Expected wrangler.preview_urls === false, got ${JSON.stringify(wrangler.preview_urls)}`,
  );

  const d1Bindings = Array.isArray(wrangler.d1_databases) ? wrangler.d1_databases : [];
  const r2Buckets = Array.isArray(wrangler.r2_buckets) ? wrangler.r2_buckets : [];
  const doBindings = Array.isArray(wrangler.durable_objects?.bindings)
    ? wrangler.durable_objects.bindings
    : [];
  const queueProducers = Array.isArray(wrangler.queues?.producers) ? wrangler.queues.producers : [];
  const queueConsumers = Array.isArray(wrangler.queues?.consumers) ? wrangler.queues.consumers : [];
  const sendEmail = Array.isArray(wrangler.send_email) ? wrangler.send_email : [];

  assertCheck(
    "wrangler.v1_bindings_intact",
    d1Bindings.some((d) => d.binding === "PLATFORM_DB") &&
      doBindings.some((d) => d.name === "TENANT_STORE" && d.class_name === "TenantStore") &&
      r2Buckets.some((b) => b.binding === "MEDIA_BUCKET") &&
      r2Buckets.some((b) => b.binding === "BACKUP_BUCKET") &&
      wrangler.images?.binding === "IMAGES" &&
      queueProducers.some((q) => q.binding === "JOBS_QUEUE") &&
      wrangler.ai?.binding === "AI" &&
      sendEmail.some((e) => e.name === "EMAIL") &&
      Array.isArray(wrangler.triggers?.crons) &&
      wrangler.triggers.crons.includes("7 * * * *"),
    "One or more v1 local bindings or cron trigger missing from apps/web/wrangler.jsonc",
  );

  const wranglerResourceNames = [
    wrangler.name,
    ...d1Bindings.map((d) => d.database_name),
    ...r2Buckets.map((b) => b.bucket_name),
    ...queueProducers.map((q) => q.queue),
    ...queueConsumers.flatMap((q) => [q.queue, q.dead_letter_queue]),
  ].filter(Boolean);

  assertCheck(
    "wrangler.resource_prefix_isolation",
    wranglerResourceNames.every(
      (n) => typeof n === "string" && n.startsWith("punyasitus-") && !n.includes("adsbook-"),
    ),
    `All wrangler resource names must use punyasitus-* prefix: ${JSON.stringify(wranglerResourceNames)}`,
  );

  // 2. Topology global invariants
  assertCheck(
    "topology.worker_exposure_disabled",
    topology.worker?.workers_dev === false && topology.worker?.preview_urls === false,
    "topology.worker must set workers_dev=false and preview_urls=false",
  );
  assertCheck(
    "topology.dcv_paths",
    Array.isArray(topology.worker?.dcvPassThroughPaths) &&
      topology.worker.dcvPassThroughPaths.includes("/.well-known/pki-validation/*") &&
      topology.worker.dcvPassThroughPaths.includes("/.well-known/acme-challenge/*") &&
      Array.isArray(topology.worker?.dcvExcludedPaths) &&
      topology.worker.dcvExcludedPaths.includes("/.well-known/cf-custom-hostname-challenge/*"),
    "topology.worker must declare HTTP DCV pass-through paths and exclude cf-custom-hostname-challenge",
  );
  assertCheck(
    "topology.no_enterprise_features",
    topology.enterpriseOnlyFeatures?.wildcard_custom_hostnames === false &&
      topology.enterpriseOnlyFeatures?.custom_metadata === false &&
      topology.enterpriseOnlyFeatures?.apex_proxying === false,
    "Enterprise-only features (wildcard_custom_hostnames, custom_metadata, apex_proxying) must be explicitly false",
  );

  const prod = topology.environments?.production;
  const stg = topology.environments?.staging;

  assertCheck(
    "topology.environments_present",
    Boolean(prod && stg),
    "Both production and staging environments must be declared",
  );

  if (prod && stg) {
    // 3. Staging vs Production SaaS zone + fallback origin separation
    assertCheck(
      "topology.staging_separate_saas_zone",
      Boolean(prod.saasZone?.zone) &&
        Boolean(stg.saasZone?.zone) &&
        stg.saasZone.zone !== prod.saasZone.zone,
      `Staging SaaS zone (${stg.saasZone?.zone}) must be distinct from production (${prod.saasZone?.zone})`,
    );
    assertCheck(
      "topology.staging_separate_fallback_origin",
      Boolean(prod.saasZone?.fallbackOrigin) &&
        Boolean(stg.saasZone?.fallbackOrigin) &&
        stg.saasZone.fallbackOrigin !== prod.saasZone.fallbackOrigin &&
        stg.saasZone.cnameTarget !== prod.saasZone.cnameTarget,
      "Staging must own its own fallbackOrigin and cnameTarget separate from production",
    );

    // 4. Production platform domains
    const prodCustomDomains = Array.isArray(prod.platformZone?.customDomains)
      ? prod.platformZone.customDomains
      : [];
    const prodHostnames = new Set(prodCustomDomains.map((d) => d.hostname));
    const prodWww = prodCustomDomains.find((d) => d.hostname === "www.punyasitus.com");
    assertCheck(
      "topology.production_platform_domains",
      prod.platformZone?.zone === "punyasitus.com" &&
        prod.platformZone?.cloudflareForSaas === false &&
        prodHostnames.has("punyasitus.com") &&
        prodHostnames.has("www.punyasitus.com") &&
        prodHostnames.has("app.punyasitus.com") &&
        prodHostnames.has("console.punyasitus.com") &&
        prodWww?.redirect?.status === 308 &&
        prodWww?.redirect?.target === "https://punyasitus.com",
      "Production platformZone must map punyasitus.com, www (308->apex), app, and console with cloudflareForSaas=false",
    );

    // 5. Per-environment SaaS zone, O2O, REQ-095, WAF, Turnstile naming, and resource prefix checks
    for (const [envName, envCfg] of [
      ["production", prod],
      ["staging", stg],
    ]) {
      const saas = envCfg.saasZone;
      const expectedFallback = `fallback.${saas?.zone}`;
      const expectedCname = `cname.${saas?.zone}`;
      const dnsRecords = Array.isArray(saas?.dnsRecords) ? saas.dnsRecords : [];
      const workerRoutes = Array.isArray(saas?.workerRoutes) ? saas.workerRoutes : [];

      assertCheck(
        `topology.${envName}.saas_dns_records`,
        saas?.cloudflareForSaas === true &&
          saas?.fallbackOrigin === expectedFallback &&
          saas?.cnameTarget === expectedCname &&
          dnsRecords.some(
            (r) => r.type === "AAAA" && r.name === "@" && r.content === "100::" && r.proxied === true,
          ) &&
          dnsRecords.some(
            (r) => r.type === "AAAA" && r.name === "*" && r.content === "100::" && r.proxied === true,
          ) &&
          dnsRecords.some(
            (r) =>
              r.type === "AAAA" &&
              r.name === "fallback" &&
              r.content === "100::" &&
              r.proxied === true,
          ) &&
          dnsRecords.some(
            (r) =>
              r.type === "CNAME" &&
              r.name === "cname" &&
              r.content === expectedFallback &&
              r.proxied === true,
          ),
        `${envName} SaaS zone must declare proxied originless AAAA (@, *, fallback -> 100::) and CNAME cname -> ${expectedFallback}`,
      );

      assertCheck(
        `topology.${envName}.saas_worker_routes_and_o2o`,
        workerRoutes.some((r) => r.pattern === "*/*" && r.worker === envCfg.workerName) &&
          workerRoutes.some(
            (r) => r.pattern === `${expectedCname}/*` && r.worker === envCfg.workerName,
          ) &&
          saas?.o2o?.supported === true &&
          saas?.o2o?.indicatorHeader === "cf-connecting-o2o" &&
          saas?.o2o?.expectedIndicatorValue === "1" &&
          saas?.o2o?.createHostnameBeforeCustomerCname === true &&
          saas?.o2o?.preValidationSupported === false,
        `${envName} SaaS zone must route */* and ${expectedCname}/* to ${envCfg.workerName} with O2O rules`,
      );

      assertCheck(
        `topology.${envName}.req095_ai_crawler_policy`,
        saas?.zoneSettings?.markdown_for_agents === true &&
          saas?.zoneSettings?.bot_fight_mode === false &&
          envCfg.platformZone?.zoneSettings?.bot_fight_mode === false,
        `${envName} must enable free Markdown for Agents and keep Free Bot Fight Mode OFF (REQ-095)`,
      );

      for (const [zoneLabel, waf] of [
        ["saasZone", saas?.waf],
        ["platformZone", envCfg.platformZone?.waf],
      ]) {
        const customRules = Array.isArray(waf?.customRules) ? waf.customRules : [];
        const rateLimitRules = Array.isArray(waf?.rateLimitRules) ? waf.rateLimitRules : [];
        assertCheck(
          `topology.${envName}.${zoneLabel}.waf_within_plan_limits`,
          typeof waf?.maxCustomRulesPerZone === "number" &&
            waf.maxCustomRulesPerZone <= 5 &&
            customRules.length <= waf.maxCustomRulesPerZone &&
            typeof waf?.maxRateLimitRulesPerZone === "number" &&
            waf.maxRateLimitRulesPerZone <= 1 &&
            rateLimitRules.length <= waf.maxRateLimitRulesPerZone,
          `${envName}.${zoneLabel} WAF rules exceed Free zone plan limits`,
        );
      }

      const turnstile = envCfg.secretsAndVars?.turnstile;
      const secretNameValues = [
        turnstile?.publicFormsSiteKeyVar,
        turnstile?.publicFormsSecretName,
        turnstile?.authSiteKeyVar,
        turnstile?.authSecretName,
        envCfg.secretsAndVars?.cloudflareForSaasZoneIdVar,
        envCfg.secretsAndVars?.cloudflareForSaasApiTokenSecretName,
        envCfg.secretsAndVars?.authSecretName,
        envCfg.secretsAndVars?.consoleAuthSecretName,
      ];
      assertCheck(
        `topology.${envName}.secrets_by_name_only`,
        secretNameValues.every((v) => typeof v === "string" && ENV_VAR_NAME_RE.test(v)),
        `${envName} secretsAndVars must contain uppercase env/secret identifiers only`,
      );

      const envResources = [
        envCfg.workerName,
        envCfg.resources?.d1,
        envCfg.resources?.r2Media,
        envCfg.resources?.r2Backup,
        envCfg.resources?.queue,
        envCfg.resources?.dlq,
      ];
      assertCheck(
        `topology.${envName}.resource_prefix_isolation`,
        envResources.every(
          (n) => typeof n === "string" && n.startsWith("punyasitus-") && !n.includes("adsbook-"),
        ),
        `${envName} resources must strictly use punyasitus-* prefix`,
      );
    }
  }

  // 6. Deep scan topology.json for leaked secret values or forbidden project prefixes
  const secretFindings = [];
  walkStrings(topology, [], (str, loc) => {
    if (loc !== "forbiddenResourcePrefixes.0" && str.toLowerCase().includes("adsbook-")) {
      secretFindings.push(`Forbidden project prefix at ${loc}`);
    }
    for (const pattern of SECRET_VALUE_PATTERNS) {
      if (pattern.re.test(str)) {
        secretFindings.push(`Possible raw secret (${pattern.name}) at ${loc}`);
      }
    }
  });
  assertCheck(
    "topology.zero_raw_secrets_or_foreign_refs",
    secretFindings.length === 0,
    secretFindings.join("; "),
  );

  return {
    ok: errors.length === 0,
    checksPassed: checks.length,
    checks,
    errors,
  };
}

async function fetchManual(urlString, extraHeaders = {}) {
  const res = await fetch(urlString, {
    method: "GET",
    redirect: "manual",
    headers: {
      "User-Agent": "punyasitus-route-verifier/1.0",
      ...extraHeaders,
    },
  });
  const body = await res.text();
  return {
    url: urlString,
    status: res.status,
    location: res.headers.get("location"),
    surface: res.headers.get("x-punyasitus-surface"),
    cacheControl: res.headers.get("cache-control"),
    xRobotsTag: res.headers.get("x-robots-tag"),
    body,
  };
}

function joinUrl(baseUrl, pathname) {
  const url = new URL(baseUrl);
  url.pathname = pathname;
  url.search = "";
  return url.toString();
}

export async function probeStagingTarget(options) {
  const errors = [];
  const probes = [];

  if (!options.target) {
    return { ok: false, probes, errors: ["Missing required --target <url>"] };
  }

  let targetUrl;
  try {
    targetUrl = new URL(options.target);
  } catch {
    return { ok: false, probes, errors: [`Invalid --target URL: ${options.target}`] };
  }

  if (targetUrl.protocol !== "https:" && targetUrl.protocol !== "http:") {
    return {
      ok: false,
      probes,
      errors: [`Unsupported protocol for --target: ${targetUrl.protocol}`],
    };
  }

  const echoPath = options.echoPath || "/";

  // 1. Target host probe (platform subdomain or primary tenant host)
  const primaryProbe = await fetchManual(joinUrl(targetUrl.toString(), echoPath));
  const expectsRedirectOnTarget =
    Boolean(options.aliasHost) &&
    new URL(options.aliasHost).host === targetUrl.host &&
    Boolean(options.expectedPrimary);

  probes.push({
    name: "target_host",
    url: primaryProbe.url,
    status: primaryProbe.status,
    surface: primaryProbe.surface,
    location: primaryProbe.location,
  });

  if (expectsRedirectOnTarget) {
    if (primaryProbe.status !== 301) {
      errors.push(`Expected 301 redirect on alias target ${primaryProbe.url}, got ${primaryProbe.status}`);
    }
  } else if (primaryProbe.status !== 200) {
    errors.push(`Expected 200 on target ${primaryProbe.url}, got ${primaryProbe.status}`);
  }

  // Host isolation check on target host
  const targetAdminProbe = await fetchManual(joinUrl(targetUrl.toString(), "/dashboard/probe"));
  probes.push({
    name: "target_host_isolation",
    url: targetAdminProbe.url,
    status: targetAdminProbe.status,
    surface: targetAdminProbe.surface,
  });
  if (targetAdminProbe.status !== 404) {
    errors.push(`Expected 404 for /dashboard/probe on ${targetUrl.host}, got ${targetAdminProbe.status}`);
  }

  // 2. Optional custom hostname probe
  if (options.customHost) {
    const customUrl = new URL(options.customHost);
    const customProbe = await fetchManual(joinUrl(customUrl.toString(), echoPath));
    probes.push({
      name: "custom_hostname",
      url: customProbe.url,
      status: customProbe.status,
      surface: customProbe.surface,
    });
    if (customProbe.status !== 200) {
      errors.push(`Expected 200 on custom host ${customProbe.url}, got ${customProbe.status}`);
    }

    const customAdminProbe = await fetchManual(joinUrl(customUrl.toString(), "/dashboard/probe"));
    probes.push({
      name: "custom_hostname_isolation",
      url: customAdminProbe.url,
      status: customAdminProbe.status,
    });
    if (customAdminProbe.status !== 404) {
      errors.push(
        `Expected 404 for /dashboard/probe on custom host ${customUrl.host}, got ${customAdminProbe.status}`,
      );
    }
  }

  // 3. Optional primary-host 301 redirect probe
  if (options.aliasHost && options.expectedPrimary) {
    const aliasUrl = new URL(options.aliasHost);
    aliasUrl.pathname = "/layanan";
    aliasUrl.search = "?utm_source=route-probe";
    const aliasProbe = await fetchManual(aliasUrl.toString());
    const expectedLocation = `https://${options.expectedPrimary}/layanan?utm_source=route-probe`;
    probes.push({
      name: "primary_redirect_301",
      url: aliasProbe.url,
      status: aliasProbe.status,
      location: aliasProbe.location,
      expectedLocation,
    });
    if (aliasProbe.status !== 301) {
      errors.push(`Expected 301 on alias ${aliasProbe.url}, got ${aliasProbe.status}`);
    }
    if (aliasProbe.location !== expectedLocation) {
      errors.push(
        `Expected Location ${expectedLocation} on alias redirect, got ${aliasProbe.location}`,
      );
    }

    // Never redirect /api/* on alias host
    const aliasApiProbe = await fetchManual(joinUrl(aliasUrl.toString(), "/api/events"));
    probes.push({
      name: "alias_api_not_redirected",
      url: aliasApiProbe.url,
      status: aliasApiProbe.status,
      location: aliasApiProbe.location,
    });
    if (aliasApiProbe.status === 301 || aliasApiProbe.status === 308) {
      errors.push(`Alias /api/* path must never redirect (got ${aliasApiProbe.status})`);
    }
  }

  // 4. Optional unknown host 404 probe
  if (options.unknownHost) {
    const unknownProbe = await fetchManual(joinUrl(options.unknownHost, "/"));
    probes.push({
      name: "unknown_host_404",
      url: unknownProbe.url,
      status: unknownProbe.status,
      cacheControl: unknownProbe.cacheControl,
      xRobotsTag: unknownProbe.xRobotsTag,
    });
    if (unknownProbe.status !== 404) {
      errors.push(`Expected 404 on unknown host ${unknownProbe.url}, got ${unknownProbe.status}`);
    }
    if (!unknownProbe.body.includes("Halaman tidak ditemukan")) {
      errors.push(`Unknown host ${unknownProbe.url} did not return neutral Indonesian 404 body`);
    }
    if (unknownProbe.cacheControl !== "no-store") {
      errors.push(
        `Expected Cache-Control: no-store on unknown host 404, got ${unknownProbe.cacheControl}`,
      );
    }
  }

  // 5. Optional platform app host probe
  if (options.platformApp) {
    const appProbe = await fetchManual(joinUrl(options.platformApp, "/api/health"));
    probes.push({
      name: "platform_app_health",
      url: appProbe.url,
      status: appProbe.status,
      surface: appProbe.surface,
    });
    if (appProbe.status !== 200) {
      errors.push(`Expected 200 on platform app health ${appProbe.url}, got ${appProbe.status}`);
    }
  }

  return {
    ok: errors.length === 0,
    probes,
    errors,
  };
}

function parseCliArgs(argv) {
  const args = {
    checkConfig: false,
    rootDir: DEFAULT_ROOT,
    target: null,
    customHost: null,
    aliasHost: null,
    expectedPrimary: null,
    unknownHost: null,
    platformApp: null,
    echoPath: "/",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--check-config") {
      args.checkConfig = true;
    } else if (token === "--root" && argv[i + 1]) {
      args.rootDir = path.resolve(argv[++i]);
    } else if (token === "--target" && argv[i + 1]) {
      args.target = argv[++i];
    } else if (token === "--custom-host" && argv[i + 1]) {
      args.customHost = argv[++i];
    } else if (token === "--alias-host" && argv[i + 1]) {
      args.aliasHost = argv[++i];
    } else if (token === "--expected-primary" && argv[i + 1]) {
      args.expectedPrimary = argv[++i];
    } else if (token === "--unknown-host" && argv[i + 1]) {
      args.unknownHost = argv[++i];
    } else if (token === "--platform-app" && argv[i + 1]) {
      args.platformApp = argv[++i];
    } else if (token === "--echo-path" && argv[i + 1]) {
      args.echoPath = argv[++i];
    } else if (token === "--help" || token === "-h") {
      console.log(
        [
          "Usage:",
          "  node scripts/verify/routes.mjs --check-config [--root <dir>]",
          "  node scripts/verify/routes.mjs --target <url> [--custom-host <url>] [--alias-host <url> --expected-primary <host>] [--unknown-host <url>] [--platform-app <url>]",
        ].join("\n"),
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${token}`);
    }
  }

  return args;
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));

  if (!args.checkConfig && !args.target) {
    console.error("Specify --check-config or --target <url>. Run with --help for usage.");
    process.exit(2);
  }

  let overallOk = true;
  const output = {};

  if (args.checkConfig) {
    const configResult = validateTopologyConfig(args.rootDir);
    output.config = configResult;
    if (!configResult.ok) overallOk = false;
  }

  if (args.target) {
    const probeResult = await probeStagingTarget(args);
    output.stagingProbe = probeResult;
    if (!probeResult.ok) overallOk = false;
  }

  const payload = JSON.stringify({ ok: overallOk, ...output }, null, 2);
  if (overallOk) {
    console.log(payload);
    process.exit(0);
  } else {
    console.error(payload);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}

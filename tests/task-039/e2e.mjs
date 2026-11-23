/* global Buffer, process, console, document, URL */
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "../..");
const webDir = path.join(root, "apps/web");
const requireFromWeb = createRequire(path.join(webDir, "package.json"));
const { chromium } = requireFromWeb("playwright-core");
const astroEntryUrl = pathToFileURL(requireFromWeb.resolve("astro")).href;

const screenshotDir = process.env.TASK039_SCREENSHOT_DIR || "";

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

function findChromeExecutable() {
  const candidates = [
    process.env.CHROMIUM_PATH,
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

async function buildDomainFixtures() {
  const astroWorkBase = path.join(webDir, ".astro");
  fs.mkdirSync(astroWorkBase, { recursive: true });
  const tmpRoot = fs.mkdtempSync(path.join(astroWorkBase, "t039-e2e-"));
  const srcDir = path.join(tmpRoot, "src");
  const pagesDir = path.join(srcDir, "pages");
  const outDir = path.join(tmpRoot, "dist");
  const cacheDir = path.join(tmpRoot, "cache");
  fs.mkdirSync(pagesDir, { recursive: true });

  const dashboardLayoutImport = path.join(webDir, "src/layouts/DashboardLayout.astro");
  const managerImport = path.join(
    webDir,
    "src/pages/dashboard/[handle]/settings/domains/_DomainsManager.tsx",
  );

  const sharedConsts = `
const fallbackItem = {
  id: 1,
  hostname: "batik-nusantara.situsku.click",
  kind: "subdomain",
  mode: null,
  sslMethod: null,
  cfCustomHostnameId: null,
  status: "active",
  hostStatus: "active",
  sslStatus: "active",
  ownershipStatus: "active",
  tlsStatus: "active",
  providerStatus: null,
  providerSslStatus: null,
  certificateAuthority: null,
  dnsTargetObserved: null,
  httpsProbePassed: true,
  isPrimary: true,
  isLocked: false,
  failureCode: null,
  lastCheckedAt: "2026-11-23T02:00:00.000Z",
  tokenIssuedAt: null,
  tokenExpiresAt: null,
  tokenAge: null,
  validationRecords: [],
  cloudflareNameserverHint: false,
  postActivationCleanup: null,
  instructions: null,
  remedies: [],
  version: 1,
};

const supportContact = {
  salesWhatsappHref: "https://wa.me/628111222333?text=Halo%20Admin%20PunyaSitus",
  salesWhatsappDisplay: "+62 811-1222-333",
  supportEmail: "support@punyasitus.com",
};
`;

  // Page 1: Active paid owner (starts clean with mode picker)
  fs.writeFileSync(
    path.join(pagesDir, "domains.astro"),
    `---
import DashboardLayout from ${JSON.stringify(dashboardLayoutImport)};
import { DomainsManager } from ${JSON.stringify(managerImport)};
${sharedConsts}
---
<DashboardLayout
  title="Domain Kustom — Batik Nusantara"
  surface="dashboard"
  workspaceName="Batik Nusantara"
  workspaceSubtitle="batik-nusantara.situsku.click"
  activeNavId="settings"
  basePath="/dashboard/batik-nusantara"
  offeringLabel="Produk"
  lifecycleStatus="active"
  publicSiteHref="https://batik-nusantara.situsku.click"
  userDisplayName="Rina Pemilik"
  userRoleLabel="Pemilik Situs"
>
  <DomainsManager
    client:load
    tenantId="01JT039E2E0000000000000001"
    handle="batik-nusantara"
    tenantName="Batik Nusantara"
    tenantStatus="active"
    currentRole="owner"
    canReadDomains={true}
    canManageDomains={true}
    cnameTarget="cname.situsku.click"
    saasZone="situsku.click"
    apiBaseUrl="/api/tenants/01JT039E2E0000000000000001/domains"
    billingHref="/dashboard/batik-nusantara/billing"
    supportContact={supportContact}
    initialItems={[fallbackItem]}
    initialCustomDomainLocked={false}
    maxCustomHostnames={2}
  />
</DashboardLayout>
`,
  );

  // Page 2: Trial tenant upgrade gate (DEC-035 C4)
  fs.writeFileSync(
    path.join(pagesDir, "domains-trial.astro"),
    `---
import DashboardLayout from ${JSON.stringify(dashboardLayoutImport)};
import { DomainsManager } from ${JSON.stringify(managerImport)};
${sharedConsts}
---
<DashboardLayout
  title="Domain Kustom — Batik Nusantara"
  surface="dashboard"
  workspaceName="Batik Nusantara"
  workspaceSubtitle="batik-nusantara.situsku.click"
  activeNavId="settings"
  basePath="/dashboard/batik-nusantara"
  offeringLabel="Produk"
  lifecycleStatus="trial"
  lifecycleDaysRemaining={5}
  publicSiteHref="https://batik-nusantara.situsku.click"
  userDisplayName="Rina Pemilik"
  userRoleLabel="Pemilik Situs"
>
  <DomainsManager
    client:load
    tenantId="01JT039E2E0000000000000002"
    handle="batik-nusantara"
    tenantName="Batik Nusantara"
    tenantStatus="trial"
    currentRole="owner"
    canReadDomains={true}
    canManageDomains={true}
    cnameTarget="cname.situsku.click"
    saasZone="situsku.click"
    apiBaseUrl="/api/tenants/01JT039E2E0000000000000002/domains"
    billingHref="/dashboard/batik-nusantara/billing"
    supportContact={supportContact}
    initialItems={[fallbackItem]}
    initialCustomDomainLocked={false}
    maxCustomHostnames={2}
  />
</DashboardLayout>
`,
  );

  // Page 3: Editor 403 denied
  fs.writeFileSync(
    path.join(pagesDir, "domains-editor.astro"),
    `---
import DashboardLayout from ${JSON.stringify(dashboardLayoutImport)};
import { DomainsManager } from ${JSON.stringify(managerImport)};
${sharedConsts}
---
<DashboardLayout
  title="Domain Kustom — Batik Nusantara"
  surface="dashboard"
  workspaceName="Batik Nusantara"
  workspaceSubtitle="batik-nusantara.situsku.click"
  activeNavId="settings"
  basePath="/dashboard/batik-nusantara"
  offeringLabel="Produk"
  lifecycleStatus="active"
  publicSiteHref="https://batik-nusantara.situsku.click"
  userDisplayName="Budi Editor"
  userRoleLabel="Editor"
>
  <DomainsManager
    client:load
    tenantId="01JT039E2E0000000000000001"
    handle="batik-nusantara"
    tenantName="Batik Nusantara"
    tenantStatus="active"
    currentRole="editor"
    canReadDomains={false}
    canManageDomains={false}
    cnameTarget="cname.situsku.click"
    saasZone="situsku.click"
    apiBaseUrl="/api/tenants/01JT039E2E0000000000000001/domains"
    billingHref="/dashboard/batik-nusantara/billing"
    supportContact={supportContact}
    initialItems={[]}
    initialCustomDomainLocked={false}
    maxCustomHostnames={2}
  />
</DashboardLayout>
`,
  );

  // Page 4: Subscription locked read-only
  fs.writeFileSync(
    path.join(pagesDir, "domains-locked.astro"),
    `---
import DashboardLayout from ${JSON.stringify(dashboardLayoutImport)};
import { DomainsManager } from ${JSON.stringify(managerImport)};
${sharedConsts}
---
<DashboardLayout
  title="Domain Kustom — Batik Nusantara"
  surface="dashboard"
  workspaceName="Batik Nusantara"
  workspaceSubtitle="batik-nusantara.situsku.click"
  activeNavId="settings"
  basePath="/dashboard/batik-nusantara"
  offeringLabel="Produk"
  lifecycleStatus="locked"
  publicSiteHref="https://batik-nusantara.situsku.click"
  userDisplayName="Rina Pemilik"
  userRoleLabel="Pemilik Situs"
>
  <DomainsManager
    client:load
    tenantId="01JT039E2E0000000000000003"
    handle="batik-nusantara"
    tenantName="Batik Nusantara"
    tenantStatus="locked"
    currentRole="owner"
    canReadDomains={true}
    canManageDomains={true}
    cnameTarget="cname.situsku.click"
    saasZone="situsku.click"
    apiBaseUrl="/api/tenants/01JT039E2E0000000000000003/domains"
    billingHref="/dashboard/batik-nusantara/billing"
    supportContact={supportContact}
    initialItems={[fallbackItem]}
    initialCustomDomainLocked={false}
    maxCustomHostnames={2}
  />
</DashboardLayout>
`,
  );

  const { build } = await import(astroEntryUrl);
  const reactIntegration = (
    await import(pathToFileURL(requireFromWeb.resolve("@astrojs/react")).href)
  ).default;
  const tailwindcss = (
    await import(pathToFileURL(requireFromWeb.resolve("@tailwindcss/vite")).href)
  ).default;

  await build({
    root: webDir,
    configFile: false,
    output: "static",
    srcDir,
    outDir,
    cacheDir,
    integrations: [reactIntegration()],
    vite: {
      plugins: [tailwindcss()],
      resolve: {
        alias: {
          "@": path.join(webDir, "src"),
        },
      },
    },
    devToolbar: { enabled: false },
    logLevel: "error",
  });

  return {
    tmpRoot,
    outDir,
    cleanup: () => fs.rmSync(tmpRoot, { recursive: true, force: true }),
  };
}

function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".js" || ext === ".mjs") return "application/javascript; charset=utf-8";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".woff2") return "font/woff2";
  if (ext === ".json") return "application/json; charset=utf-8";
  return "application/octet-stream";
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        resolve({});
      }
    });
  });
}

function makeMigrationItem(id, hostname, stage, version, isPrimary) {
  const ownActive = stage >= 1;
  const tlsActive = stage >= 2;
  const cnameActive = stage >= 3;
  const cutoverLocked = !(ownActive && tlsActive);

  const ownershipRec = {
    recordType: "TXT",
    name: `_cf-custom-hostname.${hostname}`,
    value: "cf-owner-token-live-039",
    purpose: "ownership",
    status: ownActive ? "verified" : "pending",
    removableAfterActive: true,
  };
  const dcvRec = {
    recordType: "CNAME",
    name: `_acme-challenge.${hostname}`,
    value: `${hostname}.dcv-delegate.situsku.click`,
    purpose: "ssl_dcv",
    status: tlsActive ? "verified" : "pending",
    removableAfterActive: false,
  };
  const routingRec = {
    recordType: "CNAME",
    name: hostname,
    value: "cname.situsku.click",
    purpose: "routing",
    status: cnameActive ? "verified" : "pending",
    removableAfterActive: false,
  };

  return {
    id,
    hostname,
    kind: "custom",
    mode: "zero_downtime_migration",
    sslMethod: "txt",
    cfCustomHostnameId: `cf-e2e-${id}`,
    status: cnameActive ? "active" : ownActive && !tlsActive ? "pending_ssl" : "pending_verification",
    hostStatus: cnameActive ? "active" : "pending",
    sslStatus: tlsActive ? "active" : "pending_validation",
    ownershipStatus: ownActive ? "active" : "pending",
    tlsStatus: tlsActive ? "active" : "pending",
    providerStatus: ownActive ? "active" : "pending",
    providerSslStatus: tlsActive ? "active" : "pending_validation",
    certificateAuthority: "lets_encrypt",
    dnsTargetObserved: cnameActive ? "cname.situsku.click" : null,
    httpsProbePassed: cnameActive,
    isPrimary,
    isLocked: cnameActive,
    failureCode: null,
    lastCheckedAt: "2026-11-23T03:05:00.000Z",
    tokenIssuedAt: "2026-11-23T03:00:00.000Z",
    tokenExpiresAt: "2026-11-30T03:00:00.000Z",
    tokenAge: null,
    validationRecords: cutoverLocked ? [ownershipRec, dcvRec] : [ownershipRec, dcvRec, routingRec],
    cloudflareNameserverHint: true,
    postActivationCleanup: cnameActive
      ? {
          summaryId:
            "Setelah domain aktif: record TXT kepemilikan boleh dihapus dengan aman, sedangkan record CNAME delegasi SSL dan CNAME routing WAJIB tetap dipertahankan.",
          removable: [
            {
              recordType: "TXT",
              name: `_cf-custom-hostname.${hostname}`,
              value: "cf-owner-token-live-039",
              purpose: "ownership",
              action: "removable",
              guidanceId:
                "Record TXT kepemilikan boleh dihapus dengan aman setelah domain berstatus aktif.",
            },
          ],
          mustKeep: [
            {
              recordType: "CNAME",
              name: `_acme-challenge.${hostname}`,
              value: `${hostname}.dcv-delegate.situsku.click`,
              purpose: "ssl_dcv",
              action: "must_keep",
              guidanceId:
                "Record CNAME delegasi SSL (Delegated DCV) WAJIB dipertahankan agar perpanjangan sertifikat otomatis tidak gagal.",
            },
            {
              recordType: "CNAME",
              name: hostname,
              value: "cname.situsku.click",
              purpose: "routing",
              action: "must_keep",
              guidanceId:
                "Record CNAME routing WAJIB dipertahankan agar situs tetap dapat diakses.",
            },
          ],
        }
      : null,
    instructions: {
      mode: "zero_downtime_migration",
      sslMethod: "txt",
      cnameTarget: "cname.situsku.click",
      createBeforeCnameSatisfied: true,
      cnameCutoverLocked: cutoverLocked,
      readyForCutover: !cutoverLocked,
      awaitingProviderTokens: false,
      steps: [
        {
          stepNumber: 1,
          key: "pre_validation_records",
          titleId: "Tambahkan record pre-validasi (situs lama tetap berjalan)",
          descriptionId:
            "Tambahkan TXT kepemilikan (_cf-custom-hostname) dan record DCV sertifikat (_acme-challenge) dari Cloudflare sementara situs lama Anda tetap live.",
          locked: false,
          completed: !cutoverLocked,
          records: [ownershipRec, dcvRec],
        },
        {
          stepNumber: 2,
          key: "wait_pre_validation",
          titleId: "Tunggu status hostname dan SSL keduanya aktif",
          descriptionId:
            "Langkah pemindahan CNAME tetap terkunci sampai status kepemilikan dan status sertifikat SSL keduanya berstatus active.",
          locked: false,
          completed: !cutoverLocked,
          records: [],
        },
        {
          stepNumber: 3,
          key: "cutover_cname",
          titleId: cutoverLocked
            ? "Terkunci: Pindahkan CNAME (menunggu kepemilikan & SSL aktif)"
            : "Siap pindah: Arahkan CNAME ke PunyaSitus",
          descriptionId: cutoverLocked
            ? "Langkah ini dikunci untuk mencegah downtime / error TLS. Tunggu hingga kepemilikan dan sertifikat SSL keduanya aktif."
            : `Kepemilikan dan SSL sudah aktif! Sekarang ubah CNAME ${hostname} ke cname.situsku.click tanpa downtime. Untuk rollback, cukup kembalikan CNAME ke target lama.`,
          locked: cutoverLocked,
          completed: cnameActive,
          records: cutoverLocked ? [] : [routingRec],
        },
      ],
      noticesId: [],
    },
    remedies: [],
    version,
  };
}

function makeStandardItem(id, hostname, active, version, isPrimary) {
  const routingRec = {
    recordType: "CNAME",
    name: hostname,
    value: "cname.situsku.click",
    purpose: "routing",
    status: active ? "verified" : "pending",
    removableAfterActive: false,
  };
  return {
    id,
    hostname,
    kind: "custom",
    mode: "new_domain",
    sslMethod: "http",
    cfCustomHostnameId: `cf-e2e-${id}`,
    status: active ? "active" : "pending_verification",
    hostStatus: active ? "active" : "pending",
    sslStatus: active ? "active" : "pending_validation",
    ownershipStatus: active ? "active" : "pending",
    tlsStatus: active ? "active" : "pending",
    providerStatus: active ? "active" : "pending",
    providerSslStatus: active ? "active" : "pending_validation",
    certificateAuthority: "lets_encrypt",
    dnsTargetObserved: active ? "cname.situsku.click" : null,
    httpsProbePassed: active,
    isPrimary,
    isLocked: active,
    failureCode: null,
    lastCheckedAt: "2026-11-23T03:06:00.000Z",
    tokenIssuedAt: null,
    tokenExpiresAt: null,
    tokenAge: null,
    validationRecords: [routingRec],
    cloudflareNameserverHint: false,
    postActivationCleanup: {
      summaryId:
        "Setelah domain aktif: record TXT kepemilikan boleh dihapus dengan aman, sedangkan record CNAME delegasi SSL dan CNAME routing WAJIB tetap dipertahankan.",
      removable: [],
      mustKeep: [
        {
          recordType: "CNAME",
          name: hostname,
          value: "cname.situsku.click",
          purpose: "routing",
          action: "must_keep",
          guidanceId:
            "Record CNAME routing WAJIB dipertahankan agar situs tetap dapat diakses.",
        },
      ],
    },
    instructions: null,
    remedies: [],
    version,
  };
}

async function startDomainsServer(outDir) {
  let nextId = 2;
  let migrationStage = 0;
  let domains = [
    {
      id: 1,
      hostname: "batik-nusantara.situsku.click",
      kind: "subdomain",
      mode: null,
      sslMethod: null,
      cfCustomHostnameId: null,
      status: "active",
      hostStatus: "active",
      sslStatus: "active",
      ownershipStatus: "active",
      tlsStatus: "active",
      providerStatus: null,
      providerSslStatus: null,
      certificateAuthority: null,
      dnsTargetObserved: null,
      httpsProbePassed: true,
      isPrimary: true,
      isLocked: false,
      failureCode: null,
      lastCheckedAt: "2026-11-23T02:00:00.000Z",
      tokenIssuedAt: null,
      tokenExpiresAt: null,
      tokenAge: null,
      validationRecords: [],
      cloudflareNameserverHint: false,
      postActivationCleanup: null,
      instructions: null,
      remedies: [],
      version: 1,
    },
  ];

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const pathname = url.pathname;

    if (pathname === "/api/tenants/01JT039E2E0000000000000001/domains" && req.method === "GET") {
      const locked = domains.some((d) => d.kind === "custom" && d.isLocked);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({ items: domains, customDomainLocked: locked, maxCustomHostnames: 2 }),
      );
      return;
    }

    if (pathname === "/api/tenants/01JT039E2E0000000000000001/domains" && req.method === "POST") {
      const body = await readJsonBody(req);
      const hostname = String(body.hostname || "").trim().toLowerCase();
      const mode = String(body.mode || "new_domain");

      // Simulate unsupported apex error for specific test hostname
      if (hostname === "unsupported-apex.id") {
        res.writeHead(422, { "Content-Type": "application/json; charset=utf-8" });
        res.end(
          JSON.stringify({
            error: {
              code: "VALIDATION_ERROR",
              reasonCode: "APEX_UNSUPPORTED_CAPABILITY",
              message:
                "Penyedia/paket domain saat ini belum mendukung proxying root/apex domain (unsupported-apex.id). Gunakan www.unsupported-apex.id sebagai domain utama.",
            },
            suggestedWwwHostname: "www.unsupported-apex.id",
          }),
        );
        return;
      }

      const id = nextId++;
      const created =
        mode === "zero_downtime_migration"
          ? makeMigrationItem(id, hostname, 0, 1, false)
          : makeStandardItem(id, hostname, false, 1, false);
      if (mode === "zero_downtime_migration") {
        migrationStage = 0;
      }
      domains.push(created);
      res.writeHead(201, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(created));
      return;
    }

    const recheckMatch = pathname.match(
      /^\/api\/tenants\/01JT039E2E0000000000000001\/domains\/(\d+)\/recheck$/,
    );
    if (recheckMatch && req.method === "POST") {
      const id = Number(recheckMatch[1]);
      const idx = domains.findIndex((d) => d.id === id);
      if (idx === -1) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { code: "NOT_FOUND", message: "Tidak ditemukan" } }));
        return;
      }
      const cur = domains[idx];
      let updated;
      if (cur.mode === "zero_downtime_migration") {
        migrationStage = Math.min(3, migrationStage + 1);
        updated = makeMigrationItem(cur.id, cur.hostname, migrationStage, cur.version + 1, cur.isPrimary);
      } else {
        updated = makeStandardItem(cur.id, cur.hostname, true, cur.version + 1, cur.isPrimary);
      }
      domains[idx] = updated;
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(updated));
      return;
    }

    const primaryMatch = pathname.match(
      /^\/api\/tenants\/01JT039E2E0000000000000001\/domains\/(\d+)\/make-primary$/,
    );
    if (primaryMatch && req.method === "POST") {
      const id = Number(primaryMatch[1]);
      domains = domains.map((d) => ({
        ...d,
        isPrimary: d.id === id,
        version: d.version + 1,
      }));
      const target = domains.find((d) => d.id === id);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(target));
      return;
    }

    const deleteMatch = pathname.match(
      /^\/api\/tenants\/01JT039E2E0000000000000001\/domains\/(\d+)$/,
    );
    if (deleteMatch && req.method === "DELETE") {
      const id = Number(deleteMatch[1]);
      const target = domains.find((d) => d.id === id);
      if (!target) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { code: "NOT_FOUND", message: "Tidak ditemukan" } }));
        return;
      }
      if (target.isLocked) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              code: "DOMAIN_LOCKED",
              message: "Domain terkunci. Untuk ganti domain, hubungi admin.",
            },
          }),
        );
        return;
      }
      domains = domains.filter((d) => d.id !== id);
      res.writeHead(204);
      res.end();
      return;
    }

    // Static Astro build assets
    let filePath = path.join(outDir, pathname === "/" ? "domains/index.html" : pathname);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
      filePath = path.join(filePath, "index.html");
    } else if (!fs.existsSync(filePath) && fs.existsSync(`${filePath}/index.html`)) {
      filePath = `${filePath}/index.html`;
    } else if (!fs.existsSync(filePath) && fs.existsSync(`${filePath}.html`)) {
      filePath = `${filePath}.html`;
    }

    if (!fs.existsSync(filePath)) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
      return;
    }

    res.writeHead(200, { "Content-Type": getContentType(filePath) });
    fs.createReadStream(filePath).pipe(res);
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    baseUrl,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function assertNoHorizontalOverflow(page, label) {
  const dims = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  assert(
    dims.scrollWidth <= dims.clientWidth + 1,
    `${label}: horizontal overflow detected (${dims.scrollWidth} > ${dims.clientWidth})`,
  );
}

async function main() {
  const fixture = await buildDomainFixtures();
  const server = await startDomainsServer(fixture.outDir);
  const browser = await chromium.launch({
    headless: true,
    executablePath: findChromeExecutable(),
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const consoleErrors = [];
  const pageErrors = [];

  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
    await context.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});
    const page = await context.newPage();
    let expectingExpected422 = false;
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        const text = msg.text();
        if (expectingExpected422 && text.includes("status of 422")) {
          return;
        }
        consoleErrors.push(text);
      }
    });
    page.on("pageerror", (err) => pageErrors.push(String(err)));

    // 1. Mode Picker, Cloudflare NS hint, Unsupported Apex Error (1440px)
    await page.goto(`${server.baseUrl}/domains`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="connect-mode-picker"]');
    await assertNoHorizontalOverflow(page, "mode-picker-1440");

    // Verify all 3 modes & Cloudflare nameserver hint are visible
    assert(
      (await page.locator('[data-mode-option="new_domain"]').isVisible()) &&
        (await page.locator('[data-mode-option="zero_downtime_migration"]').isVisible()) &&
        (await page.locator('[data-mode-option="cloudflare_o2o"]').isVisible()),
      "All 3 connect mode cards must be visible",
    );
    assert(
      await page.locator('[data-testid="cloudflare-nameserver-hint"]').isVisible(),
      "Cloudflare nameserver hint must be visible",
    );

    if (screenshotDir) {
      fs.mkdirSync(screenshotDir, { recursive: true });
      await page.screenshot({
        path: path.join(screenshotDir, "domains-mode-picker-1440.png"),
        fullPage: true,
      });
    }

    // Test unsupported apex capability surfacing cleanly
    await page.fill("#custom-hostname-input", "unsupported-apex.id");
    await page.waitForSelector('[data-testid="apex-flattening-notice"]');
    await page.check('[data-testid="confirm-apex-checkbox"]');
    expectingExpected422 = true;
    await page.click('[data-testid="connect-domain-submit"]');
    await page.waitForSelector('[data-testid="connect-domain-error"]');
    expectingExpected422 = false;
    const apexErrText = await page.locator('[data-testid="connect-domain-error"]').innerText();
    assert(
      apexErrText.includes("www.unsupported-apex.id"),
      "Unsupported apex error must suggest www counterpart",
    );

    // 2. Two-Step Zero-Downtime Migration flow (records first -> CNAME revealed ONLY after BOTH ownership & TLS active!)
    await page.click('[data-mode-option="zero_downtime_migration"]');
    await page.fill("#custom-hostname-input", "www.batiknusantara.id");
    await page.click('[data-testid="connect-domain-submit"]');
    await page.waitForSelector('[data-testid="domain-card-www.batiknusantara.id"]');

    // Stage 0: both pending -> CNAME cutover LOCKED, routing CNAME hidden
    const stepper = page.locator('[data-testid="migration-stepper-www.batiknusantara.id"]');
    assert(
      (await stepper.getAttribute("data-cutover-locked")) === "true",
      "Two-step migration cutover must start LOCKED",
    );
    assert(
      (await page
        .locator('[data-testid="dns-records-www.batiknusantara.id"] [data-record-purpose="routing"]')
        .count()) === 0,
      "Routing CNAME must NOT appear before both ownership and TLS are active",
    );

    // Verify independent Ownership & TLS badges both show pending (no false success!)
    assert(
      (await page.locator('[data-testid="ownership-badge-www.batiknusantara.id"]').innerText()).includes(
        "Menunggu",
      ),
      "Ownership badge must show Menunggu initially",
    );
    assert(
      (await page.locator('[data-testid="tls-badge-www.batiknusantara.id"]').innerText()).includes(
        "Menunggu",
      ),
      "TLS badge must show Menunggu initially",
    );

    // Stage 1 Recheck: Ownership ACTIVE, TLS still PENDING -> CNAME cutover STILL LOCKED!
    await page.click('[data-testid="recheck-btn-www.batiknusantara.id"]');
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-testid="domain-card-www.batiknusantara.id"]')
          ?.getAttribute("data-ownership-status") === "active",
    );
    assert(
      (await stepper.getAttribute("data-cutover-locked")) === "true",
      "Cutover must remain LOCKED when only ownership is active and TLS is still pending!",
    );
    assert(
      (await page
        .locator('[data-testid="dns-records-www.batiknusantara.id"] [data-record-purpose="routing"]')
        .count()) === 0,
      "Routing CNAME must still be hidden while TLS is pending!",
    );

    // Stage 2 Recheck: BOTH Ownership AND TLS active -> CNAME cutover UNLOCKED & revealed!
    await page.click('[data-testid="recheck-btn-www.batiknusantara.id"]');
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-testid="migration-stepper-www.batiknusantara.id"]')
          ?.getAttribute("data-cutover-locked") === "false",
    );
    assert(
      (await page
        .locator('[data-testid="dns-records-www.batiknusantara.id"] [data-record-purpose="routing"]')
        .count()) > 0,
      "Routing CNAME MUST be revealed once BOTH ownership & TLS are active!",
    );

    // Test Copy button (>= 44px tap target + visual Tersalin feedback)
    const copyBtn = page
      .locator('[data-testid="dns-records-www.batiknusantara.id"] [data-copy-record-value="cname.situsku.click"]')
      .last();
    const copyBox = await copyBtn.boundingBox();
    assert(copyBox && copyBox.height >= 44, `Copy button height must be >= 44px (got ${copyBox?.height})`);
    await copyBtn.click();
    await copyBtn.getByText("Tersalin").waitFor({ timeout: 3000 });
    assert((await copyBtn.innerText()).includes("Tersalin"), "Copy button must confirm Tersalin");

    if (screenshotDir) {
      await page.evaluate(() => document.documentElement.scrollTo(0, 0));
      await page.waitForTimeout(100);
      await page.screenshot({
        path: path.join(screenshotDir, "domains-two-step-migration-1440.png"),
        fullPage: true,
      });
    }

    // 3. Stage 3 Recheck: CNAME pointed -> ACTIVE & LOCKED + Post-Activation Cleanup Guidance!
    await page.click('[data-testid="recheck-btn-www.batiknusantara.id"]');
    await page.waitForSelector('[data-testid="post-activation-cleanup-www.batiknusantara.id"]');
    await page.waitForSelector('[data-testid="post-activation-locked-banner"]');

    const cleanupText = await page
      .locator('[data-testid="post-activation-cleanup-www.batiknusantara.id"]')
      .innerText();
    assert(
      cleanupText.includes("TXT kepemilikan") && cleanupText.includes("WAJIB"),
      "Post-activation cleanup must state TXT removable and delegation/routing CNAME must stay",
    );

    const lockedText = await page.locator('[data-testid="post-activation-locked-banner"]').innerText();
    assert(
      lockedText.includes("Domain aktif terkunci — hubungi admin platform untuk penggantian/penghapusan"),
      "Locked banner must show exact Bahasa Indonesia contact-admin notice",
    );

    // Owner delete button MUST NOT exist on the active locked domain
    assert(
      (await page.locator('[data-testid="remove-domain-btn-www.batiknusantara.id"]').count()) === 0,
      "Active locked domain must NOT expose direct owner delete button",
    );

    // 4. While locked: add counterpart (`batiknusantara.id`), test pre-activation removal dialog, re-add, activate, and atomic primary switch!
    await page.click('[data-testid="prefill-counterpart-btn"]');
    await page.click('[data-mode-option="new_domain"]');
    await page.check('[data-testid="confirm-apex-checkbox"]');
    await page.click('[data-testid="connect-domain-submit"]');
    await page.waitForSelector('[data-testid="domain-card-batiknusantara.id"]');

    // Pre-activation counterpart IS removable via accessible Base UI Dialog (test Escape first, then confirm)
    await page.click('[data-testid="remove-domain-btn-batiknusantara.id"]');
    await page.waitForSelector('[data-testid="remove-domain-dialog"]');
    await page.keyboard.press("Escape");
    await page.waitForSelector('[data-testid="remove-domain-dialog"]', { state: "hidden" });

    // Open again and confirm exact hostname removal
    await page.click('[data-testid="remove-domain-btn-batiknusantara.id"]');
    await page.fill('[data-testid="confirm-remove-input"]', "batiknusantara.id");
    await page.click('[data-testid="confirm-remove-submit"]');
    await page.waitForSelector('[data-testid="domain-card-batiknusantara.id"]', { state: "hidden" });

    // Re-add counterpart, activate it, and perform Primary Switch while locked!
    await page.click('[data-testid="prefill-counterpart-btn"]');
    await page.check('[data-testid="confirm-apex-checkbox"]');
    await page.click('[data-testid="connect-domain-submit"]');
    await page.waitForSelector('[data-testid="domain-card-batiknusantara.id"]');
    await page.click('[data-testid="recheck-btn-batiknusantara.id"]');
    await page.waitForSelector('[data-testid="make-primary-btn-batiknusantara.id"]');
    await page.click('[data-testid="make-primary-btn-batiknusantara.id"]');
    await page.waitForSelector('[data-testid="primary-badge-batiknusantara.id"]');
    await page.waitForSelector('[data-testid="alias-badge-www.batiknusantara.id"]');

    if (screenshotDir) {
      await page.evaluate(() => document.documentElement.scrollTo(0, 0));
      await page.waitForTimeout(100);
      await page.screenshot({
        path: path.join(screenshotDir, "domains-active-locked-1440.png"),
        fullPage: true,
      });
    }

    // 5. Tablet (768px) & Mobile (360px) responsive checks + tap targets + mobile screenshot
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.waitForTimeout(150);
    await assertNoHorizontalOverflow(page, "active-locked-768");

    await page.setViewportSize({ width: 360, height: 800 });
    await page.waitForTimeout(150);
    await assertNoHorizontalOverflow(page, "active-locked-360");

    // Verify mobile copy button >= 44px tap target
    const mobileCopyBtn = page
      .locator('[data-testid="dns-records-www.batiknusantara.id"] [data-copy-record-value]')
      .first();
    const mobileCopyBox = await mobileCopyBtn.boundingBox();
    assert(
      mobileCopyBox && mobileCopyBox.height >= 44 && mobileCopyBox.width >= 44,
      `Mobile copy button must be >= 44x44px (got ${mobileCopyBox?.width}x${mobileCopyBox?.height})`,
    );

    if (screenshotDir) {
      await page.evaluate(() => document.documentElement.scrollTo(0, 0));
      await page.waitForTimeout(100);
      await page.screenshot({
        path: path.join(screenshotDir, "domains-mobile-360.png"),
        fullPage: true,
      });
    }

    // 6. Verify Trial, Editor (403), and Locked Subscription screens
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${server.baseUrl}/domains-trial`, { waitUntil: "networkidle" });
    const trialText = await page.locator('[data-testid="trial-domain-gate"]').innerText();
    assert(
      trialText.includes("Domain kustom aktif setelah berlangganan berbayar"),
      "Trial screen must display DEC-035 C4 upgrade notice",
    );
    assert(
      await page.locator('[data-testid="connect-domain-submit"]').isDisabled(),
      "Connect submit must be disabled on trial",
    );

    await page.goto(`${server.baseUrl}/domains-editor`, { waitUntil: "networkidle" });
    assert(
      await page.locator('[data-testid="domains-permission-denied"]').isVisible(),
      "Editor must see 403 permission denial screen",
    );

    await page.goto(`${server.baseUrl}/domains-locked`, { waitUntil: "networkidle" });
    assert(
      await page.locator('[data-testid="subscription-locked-banner"]').isVisible(),
      "Locked tenant must see read-only subscription locked banner",
    );

    // Keyboard focus accessibility smoke check
    await page.goto(`${server.baseUrl}/domains`, { waitUntil: "networkidle" });
    await page.keyboard.press("Tab");
    const hasFocusedElement = await page.evaluate(
      () => Boolean(document.activeElement && document.activeElement !== document.body),
    );
    assert(hasFocusedElement, "Keyboard Tab navigation must move focus to an interactive element");

    assert(consoleErrors.length === 0, `Console errors detected: ${consoleErrors.join("; ")}`);
    assert(pageErrors.length === 0, `Page errors detected: ${pageErrors.join("; ")}`);

    console.log("TASK-039 E2E PASSED: 360px/768px/1440px, 3 modes, 2-step migration gate, CF hint, post-activation cleanup, locked state, counterpart add, primary switch, safe removal, trial/editor/locked gates!");
  } finally {
    await browser.close();
    await server.close();
    fixture.cleanup();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

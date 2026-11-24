#!/usr/bin/env node
/* global process, console, window, PerformanceObserver, document, URL, performance */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import zlib from "node:zlib";
import {
  assert,
  createSeededM1Topology,
  httpRequest,
  launchM1Chromium,
} from "../e2e-gate/_m1-harness.mjs";

const MAX_FIRST_PARTY_PUBLIC_JS_GZIP_BYTES = 25 * 1024; // 25 KiB per PLAN.md §9
const MAX_INITIAL_TRANSFERRED_ASSETS_BYTES = 500 * 1024; // 500 KiB per PLAN.md §9
const MAX_MEDIAN_LCP_MS = 2500;
const MAX_CLS = 0.1;
const DEFAULT_RUNS_PER_ROUTE = 5;
const ALLOWED_TRACKED_CLS_WAIVERS = new Set(["M1-FU-08"]);

const MOBILE_PROFILE = Object.freeze({
  viewport: { width: 360, height: 800 },
  cpuSlowdownRate: 4,
  downloadThroughputBytesPerSec: Math.round((1.6 * 1024 * 1024) / 8), // 1.6 Mbps
  uploadThroughputBytesPerSec: Math.round((750 * 1024) / 8), // 750 Kbps
  latencyMs: 150,
});

function parseCliArgs(argv) {
  const args = {
    runs: DEFAULT_RUNS_PER_ROUTE,
    allowTrackedClsDeviation: null,
    reportOut: null,
    jsonOnly: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--runs" && argv[i + 1]) {
      const n = Number.parseInt(argv[++i], 10);
      if (!Number.isInteger(n) || n < 1 || n > 15) {
        throw new Error(`Invalid --runs value: ${n} (expected integer 1..15)`);
      }
      args.runs = n;
    } else if (token.startsWith("--allow-tracked-cls-deviation=")) {
      args.allowTrackedClsDeviation = token.slice("--allow-tracked-cls-deviation=".length).trim();
    } else if (token === "--allow-tracked-cls-deviation" && argv[i + 1]) {
      args.allowTrackedClsDeviation = argv[++i].trim();
    } else if (token === "--report-out" && argv[i + 1]) {
      args.reportOut = path.resolve(argv[++i]);
    } else if (token === "--json") {
      args.jsonOnly = true;
    } else if (token === "--help" || token === "-h") {
      console.log(
        "Usage: node tests/performance/release-lab.mjs [--runs 5] [--allow-tracked-cls-deviation=M1-FU-08] [--json] [--report-out <path>]",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${token}`);
    }
  }
  if (
    args.allowTrackedClsDeviation !== null &&
    !ALLOWED_TRACKED_CLS_WAIVERS.has(args.allowTrackedClsDeviation)
  ) {
    throw new Error(
      `Unsupported --allow-tracked-cls-deviation waiver "${args.allowTrackedClsDeviation}" (allowed: ${[...ALLOWED_TRACKED_CLS_WAIVERS].join(", ")})`,
    );
  }
  return args;
}

export function percentile(sortedValues, p) {
  if (sortedValues.length === 0) return null;
  const sorted = [...sortedValues].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const frac = idx - lo;
  return Number((sorted[lo] + (sorted[hi] - sorted[lo]) * frac).toFixed(4));
}

async function seedM2VerticalRoutes(topology) {
  const { port, tenantA } = topology;
  const headers = {
    "Content-Type": "application/json",
    Origin: `http://127.0.0.1:${port}`,
    Cookie: tenantA.cookie,
  };

  // Seed & publish M2 Vehicle Showroom offering (/kendaraan/toyota-innova-zenix-hybrid-2024)
  const vehicleCreate = await httpRequest(port, `/api/tenants/${tenantA.handle}/catalog`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      offeringType: "vehicle",
      title: "Toyota Kijang Innova Zenix Q Hybrid 2024",
      slug: "toyota-innova-zenix-hybrid-2024",
      summary: "MPV hybrid terawat, pajak panjang, buku servis lengkap resmi.",
      description:
        "<p>Unit pilihan bebas tabrak dan bebas banjir. Tersedia estimasi simulasi kredit transparan.</p>",
      priceMode: "fixed",
      price: 485000000,
      negotiable: true,
      ctaMode: "whatsapp",
      unitStatus: "available",
      attributes: {
        brand: "Toyota",
        model: "Kijang Innova Zenix",
        variant: "Q Hybrid Modellista",
        year: 2024,
        condition: "used",
        transmission: "cvt",
        fuelType: "hybrid",
        bodyType: "mpv",
        mileageKm: 18500,
        color: "Putih Mutiara",
        seats: 7,
        engineCc: 1987,
        location: "Jakarta Selatan",
        plateRegion: "B (Jakarta)",
        ownershipCount: 1,
        unitStatus: "available",
        creditEstimateEnabled: true,
        creditEstimateConfig: {
          annualFlatRateBps: 650,
          dpPercents: [20, 30, 40],
          tenorMonths: [12, 24, 36, 48],
        },
      },
    }),
  });
  assert(
    vehicleCreate.status === 201,
    `Failed creating vehicle offering: ${vehicleCreate.status} ${vehicleCreate.body.slice(0, 300)}`,
  );
  const vJson = JSON.parse(vehicleCreate.body);
  const vId = vJson.offering?.id ?? vJson.data?.id ?? vJson.id;
  const vVer = vJson.offering?.version ?? vJson.data?.version ?? vJson.version ?? 1;
  const vehiclePub = await httpRequest(port, `/api/tenants/${tenantA.handle}/catalog/${vId}/publish`, {
    method: "POST",
    headers,
    body: JSON.stringify({ expectedVersion: vVer }),
  });
  assert(vehiclePub.status === 200, `Failed publishing vehicle offering: ${vehiclePub.status}`);

  // Seed & publish M2 Tour offering (/tour/paket-umrah-reguler-9-hari)
  const tourCreate = await httpRequest(port, `/api/tenants/${tenantA.handle}/catalog`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      offeringType: "tour",
      title: "Paket Umrah Reguler 9 Hari Hotel Dekat Masjid",
      slug: "paket-umrah-reguler-9-hari",
      summary: "Keberangkatan resmi dengan pembimbing berpengalaman dan jadwal terstruktur.",
      description: "<p>Termasuk tiket pesawat pulang-pergi, hotel bintang 4, dan manasik lengkap.</p>",
      priceMode: "from",
      price: 29500000,
      ctaMode: "whatsapp",
      attributes: {
        durationDays: 9,
        durationNights: 7,
        destination: "Makkah & Madinah",
        departureCity: "Jakarta (CGK)",
        airline: "Garuda Indonesia",
        hotel: "Setaraf Bintang 4",
        ppiuNumber: "U.123/2025",
        minPax: 2,
        departures: [
          {
            departureDate: "2027-02-15",
            seatsAvailable: 18,
            status: "open",
            note: "Keberangkatan awal Syaban",
          },
        ],
      },
    }),
  });
  assert(
    tourCreate.status === 201,
    `Failed creating tour offering: ${tourCreate.status} ${tourCreate.body.slice(0, 300)}`,
  );
  const tJson = JSON.parse(tourCreate.body);
  const tId = tJson.offering?.id ?? tJson.data?.id ?? tJson.id;
  const tVer = tJson.offering?.version ?? tJson.data?.version ?? tJson.version ?? 1;
  const tourPub = await httpRequest(port, `/api/tenants/${tenantA.handle}/catalog/${tId}/publish`, {
    method: "POST",
    headers,
    body: JSON.stringify({ expectedVersion: tVer }),
  });
  assert(tourPub.status === 200, `Failed publishing tour offering: ${tourPub.status}`);

  return {
    vehiclePath: "/kendaraan/toyota-innova-zenix-hybrid-2024",
    tourPath: "/tour/paket-umrah-reguler-9-hari",
  };
}

async function measureSingleMobileRun(browser, { url, routeName, runIndex, tenantHost }) {
  const context = await browser.newContext({ viewport: MOBILE_PROFILE.viewport });
  try {
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: MOBILE_PROFILE.cpuSlowdownRate });
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      downloadThroughput: MOBILE_PROFILE.downloadThroughputBytesPerSec,
      uploadThroughput: MOBILE_PROFILE.uploadThroughputBytesPerSec,
      latency: MOBILE_PROFILE.latencyMs,
    });

    await page.addInitScript(() => {
      window.__labPerf = { lcpMs: null, cls: 0, clsSources: [] };
      try {
        new PerformanceObserver((list) => {
          const entries = list.getEntries();
          const last = entries[entries.length - 1];
          if (last) window.__labPerf.lcpMs = Math.round(last.startTime);
        }).observe({ type: "largest-contentful-paint", buffered: true });
      } catch {
        // ignore unsupported observer
      }
      try {
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (!entry.hadRecentInput) {
              window.__labPerf.cls += entry.value;
              const nodes = (entry.sources || [])
                .map((s) => (s.node ? `${s.node.tagName}.${s.node.className || ""}` : "unknown"))
                .slice(0, 3);
              window.__labPerf.clsSources.push({
                value: Number(entry.value.toFixed(4)),
                nodes,
              });
            }
          }
        }).observe({ type: "layout-shift", buffered: true });
      } catch {
        // ignore unsupported observer
      }
    });

    const firstPartyJsUrls = new Map();
    let initialTransferredGzipBytes = 0;
    const thirdPartyRequests = [];
    const pageErrors = [];
    const bodyReadFailures = [];
    const pendingBodyReads = [];

    page.on("pageerror", (err) => pageErrors.push(String(err)));
    page.on("request", (req) => {
      const reqUrl = req.url();
      if (reqUrl.startsWith("data:") || reqUrl.startsWith("blob:")) return;
      try {
        const host = new URL(reqUrl).hostname.toLowerCase();
        if (host !== tenantHost && host !== "127.0.0.1" && host !== "localhost") {
          thirdPartyRequests.push(reqUrl);
        }
      } catch {
        // ignore
      }
    });

    page.on("response", (res) => {
      const p = (async () => {
        const resUrl = res.url();
        const status = res.status();
        if (resUrl.startsWith("data:") || resUrl.startsWith("blob:")) return;
        if (status >= 300 && status < 400) return;
        try {
          const host = new URL(resUrl).hostname.toLowerCase();
          const ct = (res.headers()["content-type"] || "").toLowerCase();
          const buf = await res.body();
          const gzipBytes = zlib.gzipSync(buf).byteLength;
          if (host === tenantHost || host === "127.0.0.1" || host === "localhost") {
            initialTransferredGzipBytes += gzipBytes;
            if (ct.includes("javascript") || resUrl.endsWith(".js") || resUrl.endsWith(".mjs")) {
              firstPartyJsUrls.set(resUrl, gzipBytes);
            }
          }
        } catch (err) {
          if (status === 200) {
            bodyReadFailures.push(`${resUrl}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      })();
      pendingBodyReads.push(p);
    });

    const resp = await page.goto(url, { waitUntil: "load", timeout: 30_000 });
    assert(
      resp && resp.status() === 200,
      `[release-lab:${routeName}:run${runIndex}] Expected 200 on ${url}, got ${resp?.status()}`,
    );

    await page.waitForTimeout(150);
    await Promise.all(pendingBodyReads);

    const metrics = await page.evaluate(() => {
      const inlineScripts = Array.from(document.querySelectorAll("script:not([src])"))
        .filter((s) => {
          const type = (s.getAttribute("type") || "").trim().toLowerCase();
          return (
            type === "" ||
            type === "text/javascript" ||
            type === "application/javascript" ||
            type === "module"
          );
        })
        .map((s) => s.textContent || "");
      const nav = performance.getEntriesByType("navigation")[0];
      const ttfbMs = nav ? Math.max(0, Math.round(nav.responseStart - nav.requestStart)) : null;
      return {
        lcpMs: window.__labPerf?.lcpMs ?? null,
        ttfbMs,
        cls: Number((window.__labPerf?.cls ?? 0).toFixed(4)),
        clsSources: window.__labPerf?.clsSources ?? [],
        domContentLoadedMs: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
        loadMs: nav ? Math.round(nav.loadEventEnd) : null,
        inlineScriptSources: inlineScripts,
      };
    });

    const externalJsBytes = Array.from(firstPartyJsUrls.values()).reduce((a, b) => a + b, 0);
    const inlineJsBytes =
      metrics.inlineScriptSources.length > 0
        ? zlib.gzipSync(metrics.inlineScriptSources.join("\n")).byteLength
        : 0;
    const totalFirstPartyJsGzipBytes = externalJsBytes + inlineJsBytes;

    assert(pageErrors.length === 0, `[release-lab:${routeName}] page errors: ${pageErrors.join("; ")}`);
    assert(
      bodyReadFailures.length === 0,
      `[release-lab:${routeName}] bodyReadFailures > 0: ${bodyReadFailures.join("; ")}`,
    );
    assert(
      thirdPartyRequests.length === 0,
      `[release-lab:${routeName}] unexpected third-party requests: ${thirdPartyRequests.join(", ")}`,
    );
    assert(
      typeof metrics.lcpMs === "number" && Number.isFinite(metrics.lcpMs),
      `[release-lab:${routeName}:run${runIndex}] LCP not observed`,
    );
    assert(
      totalFirstPartyJsGzipBytes <= MAX_FIRST_PARTY_PUBLIC_JS_GZIP_BYTES,
      `[release-lab:${routeName}] JS gzip ${totalFirstPartyJsGzipBytes}B > ${MAX_FIRST_PARTY_PUBLIC_JS_GZIP_BYTES}B`,
    );
    assert(
      initialTransferredGzipBytes <= MAX_INITIAL_TRANSFERRED_ASSETS_BYTES,
      `[release-lab:${routeName}] Initial assets ${initialTransferredGzipBytes}B > ${MAX_INITIAL_TRANSFERRED_ASSETS_BYTES}B`,
    );

    return {
      route: routeName,
      runIndex,
      url,
      responsesMeasured: pendingBodyReads.length,
      bodyReadFailures: bodyReadFailures.length,
      ttfbMs: metrics.ttfbMs,
      lcpMs: metrics.lcpMs,
      cls: metrics.cls,
      clsWithinTarget: metrics.cls <= MAX_CLS,
      clsSources: metrics.clsSources,
      firstPartyJsGzipBytes: totalFirstPartyJsGzipBytes,
      initialTransferredGzipBytes,
      domContentLoadedMs: metrics.domContentLoadedMs,
      loadMs: metrics.loadMs,
      thirdPartyRequestCount: thirdPartyRequests.length,
    };
  } finally {
    await context.close();
  }
}

export async function runReleasePerformanceLab({
  runsPerRoute = DEFAULT_RUNS_PER_ROUTE,
  allowTrackedClsDeviation = null,
} = {}) {
  const topology = await createSeededM1Topology({ prefix: "rel-lab", withSecondTenant: false });
  let browser;
  try {
    const m2Seeded = await seedM2VerticalRoutes(topology);
    browser = await launchM1Chromium();
    const browserVersion = browser.version();
    const baseHost = topology.tenantA.host;
    const baseUrl = `http://${baseHost}:${topology.port}`;

    const targetRoutes = [
      { routeName: "homepage", path: "/", url: `${baseUrl}/` },
      {
        routeName: "article_detail",
        path: topology.seeded.articlePath,
        url: `${baseUrl}${topology.seeded.articlePath}`,
      },
      {
        routeName: "service_detail",
        path: topology.seeded.offeringPath,
        url: `${baseUrl}${topology.seeded.offeringPath}`,
      },
      {
        routeName: "vehicle_detail",
        path: m2Seeded.vehiclePath,
        url: `${baseUrl}${m2Seeded.vehiclePath}`,
      },
      {
        routeName: "tour_detail",
        path: m2Seeded.tourPath,
        url: `${baseUrl}${m2Seeded.tourPath}`,
      },
    ];

    const routeSummaries = [];
    const allRuns = [];

    for (const target of targetRoutes) {
      const runs = [];
      for (let i = 1; i <= runsPerRoute; i += 1) {
        const run = await measureSingleMobileRun(browser, {
          url: target.url,
          routeName: target.routeName,
          runIndex: i,
          tenantHost: baseHost,
        });
        runs.push(run);
        allRuns.push(run);
      }

      const lcps = runs.map((r) => r.lcpMs);
      const ttfbs = runs.map((r) => r.ttfbMs).filter((v) => typeof v === "number");
      const clses = runs.map((r) => r.cls);
      const jsBytes = runs.map((r) => r.firstPartyJsGzipBytes);
      const assetBytes = runs.map((r) => r.initialTransferredGzipBytes);

      const p50LcpMs = percentile(lcps, 50);
      const p95LcpMs = percentile(lcps, 95);
      const p50TtfbMs = percentile(ttfbs, 50);
      const p95TtfbMs = percentile(ttfbs, 95);
      const p50Cls = percentile(clses, 50);
      const p95Cls = percentile(clses, 95);
      const maxJs = Math.max(...jsBytes);
      const maxAssets = Math.max(...assetBytes);

      assert(
        p50LcpMs !== null && p50LcpMs < MAX_MEDIAN_LCP_MS,
        `[release-lab:${target.routeName}] Median LCP ${p50LcpMs}ms exceeds ${MAX_MEDIAN_LCP_MS}ms`,
      );

      routeSummaries.push({
        route: target.routeName,
        path: target.path,
        runsCompleted: runs.length,
        lcpMs: { p50: p50LcpMs, p95: p95LcpMs, min: Math.min(...lcps), max: Math.max(...lcps) },
        ttfbMs: { p50: p50TtfbMs, p95: p95TtfbMs },
        cls: { p50: p50Cls, p95: p95Cls, max: Math.max(...clses), withinTarget: Math.max(...clses) <= MAX_CLS },
        maxFirstPartyJsGzipBytes: maxJs,
        maxInitialTransferredGzipBytes: maxAssets,
        bodyReadFailures: runs.reduce((acc, r) => acc + r.bodyReadFailures, 0),
      });
    }

    const totalBodyReadFailures = allRuns.reduce((sum, r) => sum + r.bodyReadFailures, 0);
    const maxFirstPartyJsGzipBytes = Math.max(...allRuns.map((r) => r.firstPartyJsGzipBytes));
    const maxInitialTransferredGzipBytes = Math.max(
      ...allRuns.map((r) => r.initialTransferredGzipBytes),
    );
    const overallLcpP50Ms = percentile(
      allRuns.map((r) => r.lcpMs),
      50,
    );
    const overallLcpP95Ms = percentile(
      allRuns.map((r) => r.lcpMs),
      95,
    );
    const overallTtfbP50Ms = percentile(
      allRuns.map((r) => r.ttfbMs).filter((v) => typeof v === "number"),
      50,
    );
    const overallTtfbP95Ms = percentile(
      allRuns.map((r) => r.ttfbMs).filter((v) => typeof v === "number"),
      95,
    );
    const overallClsP50 = percentile(
      allRuns.map((r) => r.cls),
      50,
    );
    const overallClsP95 = percentile(
      allRuns.map((r) => r.cls),
      95,
    );
    const maxObservedCls = Math.max(...allRuns.map((r) => r.cls));
    const clsBudgetMet =
      maxObservedCls <= MAX_CLS &&
      (overallClsP50 ?? 0) <= MAX_CLS &&
      (overallClsP95 ?? 0) <= MAX_CLS;

    const knownDeviations = [];
    if (!clsBudgetMet) {
      const breachingNodes = Array.from(
        new Set(
          allRuns
            .filter((r) => !r.clsWithinTarget)
            .flatMap((r) => r.clsSources.flatMap((s) => s.nodes)),
        ),
      );
      knownDeviations.push(
        `M1-FU-08: cold mobile CLS p50=${overallClsP50}, p95=${overallClsP95}, max=${maxObservedCls} > ${MAX_CLS} on ${breachingNodes.join(", ") || "unknown"} (open pre-launch CSS geometry follow-up)`,
      );
    }

    const waiverApplied = !clsBudgetMet && allowTrackedClsDeviation !== null;
    const ok = clsBudgetMet || waiverApplied;
    const verdict = clsBudgetMet
      ? "PASS"
      : waiverApplied
        ? `PASS_WITH_TRACKED_CLS_DEVIATION (${allowTrackedClsDeviation})`
        : "FAIL_CLS_BUDGET_EXCEEDED";

    return {
      ok,
      verdict,
      gate: "PLAN_SECTION_9_5_RUN_MOBILE_PERFORMANCE_LAB",
      task: "TASK-038",
      requirement: "REQ-041",
      measuredAt: new Date().toISOString(),
      targetArtifact: "apps/web/dist/server/wrangler.json (@astrojs/cloudflare production build)",
      browser: { name: "chromium", version: browserVersion },
      profile: MOBILE_PROFILE,
      runsPerRoute,
      budgets: {
        maxFirstPartyPublicJsGzipBytes: MAX_FIRST_PARTY_PUBLIC_JS_GZIP_BYTES,
        maxInitialTransferredAssetsBytes: MAX_INITIAL_TRANSFERRED_ASSETS_BYTES,
        maxMedianLcpMs: MAX_MEDIAN_LCP_MS,
        maxCls: MAX_CLS,
      },
      inp: {
        status: "FIELD_DATA_ONLY_CRUX_RUM_28D",
        valueMs: null,
        note: "INP is real-user field data (28-day CrUX/RUM p75 when traffic sample permits) and is NEVER fabricated from synthetic lab runs (PLAN.md §9).",
      },
      summary: {
        routesMeasured: targetRoutes.length,
        totalRunsCompleted: allRuns.length,
        bodyReadFailures: totalBodyReadFailures,
        lcpMs: { p50: overallLcpP50Ms, p95: overallLcpP95Ms },
        ttfbMs: { p50: overallTtfbP50Ms, p95: overallTtfbP95Ms },
        cls: {
          p50: overallClsP50,
          p95: overallClsP95,
          max: maxObservedCls,
          clsBudgetMet,
          trackedWaiver: waiverApplied ? allowTrackedClsDeviation : null,
          waiverRemovalRequiredBeforeLiveLaunch: waiverApplied,
        },
        clsBudgetMet,
        trackedWaiver: waiverApplied ? allowTrackedClsDeviation : null,
        maxFirstPartyJsGzipBytes,
        maxInitialTransferredGzipBytes,
        knownDeviations,
      },
      routeSummaries,
      runs: allRuns,
    };
  } finally {
    if (browser) await browser.close();
    await topology.cleanup();
  }
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const report = await runReleasePerformanceLab({
    runsPerRoute: args.runs,
    allowTrackedClsDeviation: args.allowTrackedClsDeviation,
  });

  if (args.reportOut) {
    fs.mkdirSync(path.dirname(args.reportOut), { recursive: true });
    fs.writeFileSync(args.reportOut, JSON.stringify(report, null, 2) + "\n", "utf8");
  }

  if (args.jsonOnly) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(
      `${report.verdict}: PLAN §9 5-Run Mobile Lab (${report.summary.routesMeasured} routes x ${report.runsPerRoute} runs = ${report.summary.totalRunsCompleted} runs) — LCP p50=${report.summary.lcpMs.p50}ms / p95=${report.summary.lcpMs.p95}ms, TTFB p50=${report.summary.ttfbMs.p50}ms / p95=${report.summary.ttfbMs.p95}ms, CLS p50=${report.summary.cls.p50} / p95=${report.summary.cls.p95} (clsBudgetMet=${String(report.summary.clsBudgetMet)}, trackedWaiver=${String(report.summary.trackedWaiver)}), maxJS=${report.summary.maxFirstPartyJsGzipBytes}B <= ${MAX_FIRST_PARTY_PUBLIC_JS_GZIP_BYTES}B, maxAssets=${report.summary.maxInitialTransferredGzipBytes}B <= ${MAX_INITIAL_TRANSFERRED_ASSETS_BYTES}B, bodyReadFailures=${report.summary.bodyReadFailures}, INP=${report.inp.status}`,
    );
    for (const dev of report.summary.knownDeviations) {
      console.log(`Known Deviation: ${dev}`);
    }
    console.log(
      JSON.stringify({
        ok: report.ok,
        verdict: report.verdict,
        summary: report.summary,
        inp: report.inp,
        reportOut: args.reportOut,
      }),
    );
  }

  if (!report.ok) {
    console.error(
      `RELEASE PERFORMANCE LAB FAILED (CLS_BUDGET_EXCEEDED): measured CLS p50=${report.summary.cls.p50}, p95=${report.summary.cls.p95}, max=${report.summary.cls.max} > ${MAX_CLS}. Pass --allow-tracked-cls-deviation=M1-FU-08 ONLY for tracked pre-launch runs; remove waiver before live production deploy.`,
    );
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error("RELEASE PERFORMANCE LAB FAILED:", err);
    process.exit(1);
  });
}

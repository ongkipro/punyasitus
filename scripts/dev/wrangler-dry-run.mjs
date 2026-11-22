import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { unstable_startWorker } from "wrangler";

const root = path.resolve(import.meta.dirname, "../..");
const webDir = path.join(root, "apps/web");
const MAX_BUNDLE_MIB = 64;
const MAX_STARTUP_MS = 1000;
const budgetOnly = process.argv.includes("--budget-only");

function dirSizeBytes(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += dirSizeBytes(full);
    } else if (entry.isFile()) {
      total += fs.statSync(full).size;
    }
  }
  return total;
}

if (!budgetOnly || !fs.existsSync(path.join(webDir, "dist"))) {
  const build = spawnSync("pnpm", ["--filter", "@punyasitus/web", "build"], {
    cwd: root,
    stdio: "inherit",
  });
  if (build.status !== 0) {
    process.exit(build.status ?? 1);
  }
}

const builtConfig = path.join(webDir, "dist/server/wrangler.json");
if (!fs.existsSync(builtConfig)) {
  console.error(`FAIL: Built Wrangler config missing at ${builtConfig}`);
  process.exit(1);
}

const outdir = fs.mkdtempSync(path.join(os.tmpdir(), "punyasitus-wrangler-dry-"));
try {
  const dry = spawnSync(
    "pnpm",
    ["exec", "wrangler", "deploy", "--dry-run", "--outdir", outdir],
    { cwd: webDir, encoding: "utf8" },
  );
  if (dry.stdout) process.stdout.write(dry.stdout);
  if (dry.stderr) process.stderr.write(dry.stderr);
  if (dry.status !== 0) {
    process.exit(dry.status ?? 1);
  }

  const totalBytes = dirSizeBytes(outdir);
  const totalMiB = totalBytes / (1024 * 1024);

  // Measure real local `workerd` cold startup + first SSR request on the built Worker.
  // Never pass silently with null: startup must be measured and strictly under 1 s.
  const tStart = performance.now();
  const worker = await unstable_startWorker({
    config: builtConfig,
    dev: {
      remote: false,
      persist: false,
      server: { hostname: "127.0.0.1", port: 0 },
      inspector: false,
    },
  });
  const readyMs = Math.round(performance.now() - tStart);
  let coldFetchMs = -1;
  try {
    const tFetch = performance.now();
    const res = await worker.fetch("http://punyasitus.com/");
    coldFetchMs = Math.round(performance.now() - tFetch);
    if (res.status !== 200 || res.headers.get("x-punyasitus-surface") !== "marketing") {
      console.error(
        `FAIL: Built Worker cold-start probe returned status=${res.status}, surface=${res.headers.get("x-punyasitus-surface")}`,
      );
      process.exit(1);
    }
  } finally {
    await worker.dispose();
  }

  const startupMatch = (dry.stdout + "\n" + dry.stderr).match(/Worker Startup Time:\s*(\d+)\s*ms/i);
  const measuredStartupMs = startupMatch ? Number(startupMatch[1]) : readyMs;

  console.log(
    JSON.stringify({
      bundleBytes: totalBytes,
      bundleMiB: Number(totalMiB.toFixed(2)),
      maxBundleMiB: MAX_BUNDLE_MIB,
      readyMs,
      coldFetchMs,
      measuredStartupMs,
      maxStartupMs: MAX_STARTUP_MS,
    }),
  );

  if (totalMiB >= MAX_BUNDLE_MIB) {
    console.error(`FAIL: Worker dry-run bundle ${totalMiB.toFixed(2)} MiB exceeds ${MAX_BUNDLE_MIB} MiB limit`);
    process.exit(1);
  }
  if (!Number.isFinite(measuredStartupMs) || measuredStartupMs < 0 || measuredStartupMs >= MAX_STARTUP_MS) {
    console.error(`FAIL: Worker startup ${measuredStartupMs} ms exceeds ${MAX_STARTUP_MS} ms limit`);
    process.exit(1);
  }
} finally {
  fs.rmSync(outdir, { recursive: true, force: true });
}

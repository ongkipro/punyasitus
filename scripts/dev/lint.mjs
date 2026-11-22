import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");

// 1. DEC-036 guard: reject any @radix-ui/* or radix-ui dependency across all workspace manifests
const manifestPaths = [
  "package.json",
  "apps/web/package.json",
  "packages/core/package.json",
  "packages/db/package.json",
  "packages/auth/package.json",
  "packages/integrations/package.json",
  "packages/plugins/package.json",
];

for (const rel of manifestPaths) {
  const full = path.join(root, rel);
  if (!fs.existsSync(full)) continue;
  const pkg = JSON.parse(fs.readFileSync(full, "utf8"));
  for (const section of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    const deps = pkg[section] ?? {};
    for (const name of Object.keys(deps)) {
      if (name === "radix-ui" || name.startsWith("@radix-ui/")) {
        console.error(`LINT ERROR: Forbidden Radix dependency "${name}" in ${rel} (DEC-036: use @base-ui/react only)`);
        process.exit(1);
      }
    }
  }
}

// 1b. DEC-036 / TASK-032 source guard: reject any @radix-ui/* / radix-ui import or Radix `asChild` prop in source code
const sourceRoots = [
  "apps/web/src",
  "packages/core/src",
  "packages/db/src",
  "packages/auth/src",
  "packages/integrations/src",
  "packages/plugins/src",
];
const sourceExts = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".astro"]);
const radixImportRe = /(?:from\s+["'](?:@radix-ui\/[^"']+|radix-ui)["']|import\s*\(\s*["'](?:@radix-ui\/[^"']+|radix-ui)["']\s*\)|require\s*\(\s*["'](?:@radix-ui\/[^"']+|radix-ui)["']\s*\))/;
const asChildPropRe = /\basChild(?:\s*=|\s*\?|\s*:|\s*,|\s*\}|\s*\)|\s*\/?>|\s+(?=[a-zA-Z0-9_$-]))/;

function walkSourceFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".astro") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkSourceFiles(full, out);
    } else if (sourceExts.has(path.extname(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

const sourceViolations = [];
const scanDirs = sourceRoots.map((relRoot) => path.join(root, relRoot));
if (process.env.PUNYASITUS_LINT_EXTRA_DIR) {
  scanDirs.push(path.resolve(process.env.PUNYASITUS_LINT_EXTRA_DIR));
}
for (const dir of scanDirs) {
  for (const file of walkSourceFiles(dir)) {
    const content = fs.readFileSync(file, "utf8");
    const relPath = path.relative(root, file);
    if (radixImportRe.test(content)) {
      sourceViolations.push(`${relPath}: forbidden @radix-ui/* or radix-ui import (DEC-036: use @base-ui/react)`);
    }
    if (asChildPropRe.test(content)) {
      sourceViolations.push(`${relPath}: forbidden Radix \`asChild\` prop (DEC-036: use Base UI \`render={...}\`)`);
    }
  }
}

if (sourceViolations.length > 0) {
  for (const v of sourceViolations) {
    console.error(`LINT ERROR: ${v}`);
  }
  process.exit(1);
}

// 2. Run ESLint with our tracked config inside scripts/dev/
const res = spawnSync(
  "pnpm",
  ["exec", "eslint", "--config", "scripts/dev/eslint.config.mjs", "apps/web/src", "packages", "tests"],
  { cwd: root, stdio: "inherit" },
);

process.exit(res.status ?? 1);

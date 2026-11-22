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

// 2. Run ESLint with our tracked config inside scripts/dev/
const res = spawnSync(
  "pnpm",
  ["exec", "eslint", "--config", "scripts/dev/eslint.config.mjs", "apps/web/src", "packages", "tests"],
  { cwd: root, stdio: "inherit" },
);

process.exit(res.status ?? 1);

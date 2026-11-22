import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  getMobileBottomTabs,
  getSidebarNavItems,
} from "../../apps/web/src/components/admin/navigation.ts";

const root = path.resolve(import.meta.dirname, "../..");
const webDir = path.join(root, "apps/web");

function walkFiles(dir: string, exts: Set<string>, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".astro") {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(full, exts, out);
    } else if (exts.has(path.extname(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

describe("TASK-032: shadcn/ui Base UI lock & DEC-036 boundary guards", () => {
  it("locks apps/web/components.json to base-nova, rsc: false, and lucide", () => {
    const cfg = JSON.parse(
      fs.readFileSync(path.join(webDir, "components.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(cfg.style).toBe("base-nova");
    expect(cfg.rsc).toBe(false);
    expect(cfg.iconLibrary).toBe("lucide");
    expect(cfg.tsx).toBe(true);
    const tailwind = cfg.tailwind as Record<string, unknown>;
    expect(tailwind.css).toBe("src/styles/admin/globals.css");
    expect(tailwind.cssVariables).toBe(true);
  });

  it("reports base-nova, rsc: false, and lucide via `pnpm exec shadcn info --json`", () => {
    const res = spawnSync("pnpm", ["exec", "shadcn", "info", "--json"], {
      cwd: webDir,
      encoding: "utf8",
    });
    expect(res.status).toBe(0);
    const info = JSON.parse(res.stdout) as {
      config: { style: string; base: string; rsc: boolean; iconLibrary: string };
    };
    expect(info.config.style).toBe("base-nova");
    expect(info.config.base).toBe("base");
    expect(info.config.rsc).toBe(false);
    expect(info.config.iconLibrary).toBe("lucide");
  });

  it("forbids any @radix-ui/* or radix-ui dependency and any Radix `asChild` prop in apps/web/src", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(webDir, "package.json"), "utf8"),
    ) as Record<string, Record<string, string>>;
    const allDeps = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ];
    expect(allDeps.filter((d) => d === "radix-ui" || d.startsWith("@radix-ui/"))).toEqual([]);
    expect(allDeps).toContain("@base-ui/react");

    const sourceFiles = walkFiles(
      path.join(webDir, "src"),
      new Set([".ts", ".tsx", ".astro", ".js", ".jsx"]),
    );
    const radixRe = /@radix-ui\/|from\s+["']radix-ui["']/;
    const asChildRe = /\basChild(?:\s*=|\s*\?|\s*:|\s*,|\s*\}|\s*\)|\s*\/?>|\s+(?=[a-zA-Z0-9_$-]))/;
    const sparklesRe = /\bSparkles(?:Icon)?\b/;

    for (const file of sourceFiles) {
      const content = fs.readFileSync(file, "utf8");
      const rel = path.relative(root, file);
      expect(radixRe.test(content), `${rel} must not reference @radix-ui/*`).toBe(false);
      expect(asChildRe.test(content), `${rel} must not use Radix asChild prop`).toBe(false);
      expect(sparklesRe.test(content), `${rel} must not use banned Sparkles icon`).toBe(false);
    }
  });

  it("fails CI lint when a source file imports @radix-ui/* or uses Radix `asChild`", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "punyasitus-lint-neg-"));
    try {
      const radixFile = path.join(tmpDir, "bad-radix.tsx");
      fs.writeFileSync(radixFile, 'import * as Dialog from "@radix-ui/react-dialog";\nexport { Dialog };\n');
      const r1 = spawnSync("node", ["scripts/dev/lint.mjs"], {
        cwd: root,
        env: { ...process.env, PUNYASITUS_LINT_EXTRA_DIR: tmpDir },
        encoding: "utf8",
      });
      expect(r1.status).not.toBe(0);
      expect(r1.stderr).toContain("forbidden @radix-ui/*");

      fs.rmSync(radixFile);
      const asChildFile = path.join(tmpDir, "bad-aschild.tsx");
      fs.writeFileSync(asChildFile, 'export function Demo() { return <button asChild className="x">Hi</button>; }\n');
      const r2 = spawnSync("node", ["scripts/dev/lint.mjs"], {
        cwd: root,
        env: { ...process.env, PUNYASITUS_LINT_EXTRA_DIR: tmpDir },
        encoding: "utf8",
      });
      expect(r2.status).not.toBe(0);
      expect(r2.stderr).toContain("asChild");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("keeps admin CSS and @base-ui/react isolated from public pages", () => {
    const publicIndex = fs.readFileSync(
      path.join(webDir, "src/pages/index.astro"),
      "utf8",
    );
    expect(publicIndex).not.toContain("styles/admin");
    expect(publicIndex).not.toContain("@base-ui/react");
    expect(publicIndex).not.toContain("components/ui");
  });

  it("enforces DESIGN.md navigation caps (<= 9 desktop items, exact 5 mobile bottom slots)", () => {
    for (const surface of ["dashboard", "agency", "affiliate", "console"] as const) {
      const desktop = getSidebarNavItems(surface);
      const mobile = getMobileBottomTabs(surface);
      expect(desktop.length).toBeGreaterThanOrEqual(5);
      expect(desktop.length).toBeLessThanOrEqual(9);
      expect(mobile.length).toBe(5);
      expect(mobile[4]?.opensMoreDrawer).toBe(true);
    }
  });

  it("excludes design-fixtures from production build output when dist exists", () => {
    const astroConfig = fs.readFileSync(path.join(webDir, "astro.config.mjs"), "utf8");
    expect(astroConfig).toContain('if (command === "dev")');

    const distServerDir = path.join(webDir, "dist/server");
    if (fs.existsSync(distServerDir)) {
      const distFiles = walkFiles(distServerDir, new Set([".mjs", ".js", ".json"]));
      for (const file of distFiles) {
        const content = fs.readFileSync(file, "utf8");
        expect(
          content.includes("design-fixtures"),
          `Production bundle ${path.relative(root, file)} must not include design-fixtures`,
        ).toBe(false);
      }
    }
  });
});

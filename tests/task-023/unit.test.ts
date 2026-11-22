import fs from "node:fs";
import path from "node:path";
import {
  classifySurfaceHost,
  createReceiptPdfBytes,
  isDcvPassThroughPath,
  normalizeHost,
} from "@punyasitus/core";
import { assertFixedProviderOrigin } from "@punyasitus/integrations";
import { assertPluginTablePrefix } from "@punyasitus/plugins";
import { describe, expect, it } from "vitest";
import { SYNTHETIC_PLATFORM_HOSTS, SYNTHETIC_TENANTS } from "../fixtures/tenants.ts";

const ROOT = path.resolve(import.meta.dirname, "../..");

describe("TASK-023 unit & pinned contract checks", () => {
  it("pins supported versions and excludes @radix-ui/* (DEC-036)", () => {
    const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    const webPkg = JSON.parse(fs.readFileSync(path.join(ROOT, "apps/web/package.json"), "utf8"));
    const authPkg = JSON.parse(fs.readFileSync(path.join(ROOT, "packages/auth/package.json"), "utf8"));
    const dbPkg = JSON.parse(fs.readFileSync(path.join(ROOT, "packages/db/package.json"), "utf8"));
    const corePkg = JSON.parse(fs.readFileSync(path.join(ROOT, "packages/core/package.json"), "utf8"));

    expect(rootPkg.packageManager).toMatch(/^pnpm@12\./);
    expect(webPkg.dependencies.astro).toMatch(/^7\.4\./);
    expect(webPkg.dependencies["@astrojs/cloudflare"]).toMatch(/^14\.4\./);
    expect(webPkg.dependencies["@base-ui/react"]).toMatch(/^1\./);
    expect(webPkg.dependencies.tailwindcss).toMatch(/^4\./);
    expect(authPkg.dependencies["better-auth"]).toMatch(/^1\./);
    expect(dbPkg.dependencies["drizzle-orm"]).toMatch(/^0\.45\./);
    expect(corePkg.dependencies["pdf-lib"]).toMatch(/^1\./);
    expect(rootPkg.devDependencies.typescript).toMatch(/^6\.0\./);

    for (const pkg of [rootPkg, webPkg, authPkg, dbPkg, corePkg]) {
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
      const radix = Object.keys(allDeps).filter(
        (name) => name === "radix-ui" || name.startsWith("@radix-ui/"),
      );
      expect(radix).toEqual([]);
    }
  });

  it("classifies the four host-isolated surfaces and rejects malformed/reserved hosts", () => {
    expect(classifySurfaceHost(SYNTHETIC_PLATFORM_HOSTS.marketing).surface).toBe("marketing");
    expect(classifySurfaceHost("www.punyasitus.com").surface).toBe("marketing");
    expect(classifySurfaceHost(SYNTHETIC_PLATFORM_HOSTS.app).surface).toBe("app");
    expect(classifySurfaceHost(SYNTHETIC_PLATFORM_HOSTS.console).surface).toBe("console");

    const t0 = classifySurfaceHost(SYNTHETIC_TENANTS[0].subdomainHost);
    expect(t0).toEqual({
      surface: "tenant",
      host: "alpha-studio.situsku.click",
      tenantHandle: "alpha-studio",
    });

    expect(classifySurfaceHost("fallback.situsku.click").surface).toBe("unknown");
    expect(classifySurfaceHost("cname.situsku.click").surface).toBe("unknown");
    expect(classifySurfaceHost("situsku.click").surface).toBe("unknown");
    expect(classifySurfaceHost("127.0.0.1:4321").surface).toBe("unknown");
    expect(normalizeHost("bad/host")).toBeNull();
    expect(normalizeHost("PUNYASITUS.COM.:443")).toBe("punyasitus.com");
  });

  it("identifies Step 0 HTTP DCV pass-through paths only", () => {
    expect(isDcvPassThroughPath("/.well-known/pki-validation/token.txt")).toBe(true);
    expect(isDcvPassThroughPath("/.well-known/acme-challenge/abc")).toBe(true);
    expect(isDcvPassThroughPath("/.well-known/cf-custom-hostname-challenge/abc")).toBe(false);
    expect(isDcvPassThroughPath("/dashboard/alpha")).toBe(false);
  });

  it("generates a valid PDF with pdf-lib", async () => {
    const bytes = await createReceiptPdfBytes({
      receiptNumber: "PS-2026-00001",
      tenantName: SYNTHETIC_TENANTS[0].siteTitle,
      amountIdr: 179_000,
    });
    const header = new TextDecoder().decode(bytes.slice(0, 5));
    expect(header).toBe("%PDF-");
    expect(bytes.byteLength).toBeGreaterThan(200);
  });

  it("enforces integration HTTPS origin and Frozen-Core plugin table prefix contracts", () => {
    expect(assertFixedProviderOrigin("https://api.example.com").hostname).toBe("api.example.com");
    expect(() => assertFixedProviderOrigin("http://insecure.example.com")).toThrow();
    expect(() => assertPluginTablePrefix("bio-links", "plg_bio_links__items")).not.toThrow();
    expect(() => assertPluginTablePrefix("bio-links", "pages")).toThrow();
  });

  it("pre-declares all v1 local bindings in apps/web/wrangler.jsonc and heavy-run wrapper", () => {
    const raw = fs.readFileSync(path.join(ROOT, "apps/web/wrangler.jsonc"), "utf8");
    for (const binding of [
      '"PLATFORM_DB"',
      '"TENANT_STORE"',
      '"MEDIA_BUCKET"',
      '"BACKUP_BUCKET"',
      '"IMAGES"',
      '"JOBS_QUEUE"',
      '"EMAIL"',
      '"AI"',
    ]) {
      expect(raw).toContain(binding);
    }
    expect(fs.existsSync(path.join(ROOT, "scripts/dev/heavy.sh"))).toBe(true);
  });
});

import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_SAAS_CNAME_TARGET,
  DomainConflictError,
  MULTI_LABEL_PUBLIC_SUFFIXES,
  areDomainCounterparts,
  assertTenantDomainSetCompatibility,
  buildConnectInstructions,
  buildPostActivationCleanupGuidance,
  evaluateApexCapability,
  evaluateTenantDomainSetCapabilities,
  isApexDomainHostname,
  isCloudflareNameserver,
  normalizeConnectMode,
  resolveSslMethodForMode,
  suggestConnectModeFromSituation,
  validateCustomHostname,
  type CloudflareCustomHostname,
} from "@punyasitus/core/domains/index";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const BASE_NOW_MS = Date.UTC(2026, 10, 23, 3, 0, 0);

function makeMigrationProvider(
  overrides: Partial<CloudflareCustomHostname> = {},
): CloudflareCustomHostname {
  return {
    id: "cf-ch-t039-01",
    hostname: "www.batiknusantara.id",
    status: "pending",
    ownership_verification: {
      type: "txt",
      name: "_cf-custom-hostname.www.batiknusantara.id",
      value: "cf-owner-token-t039-xyz",
    },
    ssl: {
      id: "cf-ssl-t039-01",
      status: "pending_validation",
      method: "txt",
      type: "dv",
      certificate_authority: "lets_encrypt",
      dcv_delegation_records: [
        {
          cname: "_acme-challenge.www.batiknusantara.id",
          cname_target: "www.batiknusantara.id.dcv-delegate.situsku.click",
        },
      ],
      settings: { min_tls_version: "1.2" },
    },
    ...overrides,
  };
}

describe("TASK-039 unit — 2-hostname counterpart rule & REQ-065 compatibility", () => {
  it("allows root + www counterpart pairs in either order and rejects unrelated 2nd or 3rd domains", () => {
    expect(areDomainCounterparts("batiknusantara.id", "www.batiknusantara.id")).toBe(true);
    expect(areDomainCounterparts("www.batiknusantara.id", "batiknusantara.id")).toBe(true);
    expect(areDomainCounterparts("batiknusantara.id", "batiknusantara.id")).toBe(false);
    expect(areDomainCounterparts("www.batiknusantara.id", "toko.batiknusantara.id")).toBe(false);
    expect(areDomainCounterparts("www.batiknusantara.id", "www.lain.id")).toBe(false);

    expect(() =>
      assertTenantDomainSetCompatibility(["batiknusantara.id"], "www.batiknusantara.id"),
    ).not.toThrow();
    expect(() =>
      assertTenantDomainSetCompatibility(["www.batiknusantara.id"], "batiknusantara.id"),
    ).not.toThrow();

    try {
      assertTenantDomainSetCompatibility(["www.batiknusantara.id"], "www.kompetitor.id");
      expect.unreachable("Expected unrelated second domain to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(DomainConflictError);
      expect((err as DomainConflictError).reasonCode).toBe("DOMAIN_SET_MISMATCH");
    }

    try {
      assertTenantDomainSetCompatibility(
        ["www.batiknusantara.id", "batiknusantara.id"],
        "shop.batiknusantara.id",
      );
      expect.unreachable("Expected 3rd custom hostname to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(DomainConflictError);
      expect((err as DomainConflictError).reasonCode).toBe("DOMAIN_LIMIT_REACHED");
    }
  });

  it("computes suggested counterpart hostname only for valid www/apex pairs", () => {
    const withWww = evaluateTenantDomainSetCapabilities([
      {
        id: 1,
        hostname: "batik.situsku.click",
        kind: "subdomain",
        status: "active",
        sslStatus: "active",
        isPrimary: true,
        isLocked: false,
      },
      {
        id: 2,
        hostname: "www.batiknusantara.id",
        kind: "custom",
        status: "active",
        sslStatus: "active",
        isPrimary: false,
        isLocked: true,
      },
    ]);
    expect(withWww.customCount).toBe(1);
    expect(withWww.canAddMoreCustomHostnames).toBe(true);
    expect(withWww.suggestedCounterpartHostname).toBe("batiknusantara.id");

    const withApex = evaluateTenantDomainSetCapabilities([
      {
        id: 2,
        hostname: "batiknusantara.id",
        kind: "custom",
        status: "active",
        sslStatus: "active",
        isPrimary: true,
        isLocked: true,
      },
    ]);
    expect(withApex.suggestedCounterpartHostname).toBe("www.batiknusantara.id");

    const withSingleSubdomain = evaluateTenantDomainSetCapabilities([
      {
        id: 2,
        hostname: "toko.batiknusantara.id",
        kind: "custom",
        status: "active",
        sslStatus: "active",
        isPrimary: true,
        isLocked: true,
      },
    ]);
    expect(withSingleSubdomain.suggestedCounterpartHostname).toBeNull();
  });
});

describe("TASK-039 unit — 3 connect modes, Cloudflare NS hint, apex capability & two-step migration gate", () => {
  it("selects appropriate connect mode from live-site situation and Cloudflare nameservers", () => {
    expect(
      suggestConnectModeFromSituation({ hasLiveSite: false, usesCloudflareNameservers: false }),
    ).toBe("new_domain");
    expect(
      suggestConnectModeFromSituation({ hasLiveSite: true, usesCloudflareNameservers: false }),
    ).toBe("zero_downtime_migration");
    expect(
      suggestConnectModeFromSituation({ hasLiveSite: true, usesCloudflareNameservers: true }),
    ).toBe("cloudflare_o2o");

    expect(normalizeConnectMode("o2o")).toBe("cloudflare_o2o");
    expect(resolveSslMethodForMode("zero_downtime_migration")).toBe("txt");
    expect(resolveSslMethodForMode("cloudflare_o2o")).toBe("http");
    expect(isCloudflareNameserver(["anna.ns.cloudflare.com", "bob.ns.cloudflare.com"])).toBe(true);
    expect(isCloudflareNameserver(["ns1.niagahoster.com", "ns2.niagahoster.com"])).toBe(false);
  });

  it("gates Mode B (zero_downtime_migration) routing CNAME strictly until BOTH ownership AND TLS are active", () => {
    // 1. Both pending -> CNAME hidden & locked
    const bothPending = buildConnectInstructions({
      hostname: "www.batiknusantara.id",
      mode: "zero_downtime_migration",
      sslMethod: "txt",
      provider: makeMigrationProvider({ status: "pending" }),
      nowMs: BASE_NOW_MS,
    });
    expect(bothPending.cnameCutoverLocked).toBe(true);
    expect(bothPending.readyForCutover).toBe(false);
    expect(bothPending.validationRecords.some((r) => r.purpose === "routing")).toBe(false);
    expect(bothPending.validationRecords.some((r) => r.purpose === "ownership")).toBe(true);
    expect(bothPending.validationRecords.some((r) => r.purpose === "ssl_dcv")).toBe(true);

    // 2. Ownership active, TLS still pending -> CNAME STILL hidden & locked!
    const onlyOwnershipActive = buildConnectInstructions({
      hostname: "www.batiknusantara.id",
      mode: "zero_downtime_migration",
      sslMethod: "txt",
      provider: makeMigrationProvider({ status: "active" }),
      nowMs: BASE_NOW_MS,
    });
    expect(onlyOwnershipActive.cnameCutoverLocked).toBe(true);
    expect(onlyOwnershipActive.readyForCutover).toBe(false);
    expect(onlyOwnershipActive.validationRecords.some((r) => r.purpose === "routing")).toBe(false);

    // 3. Ownership pending, TLS active -> CNAME STILL hidden & locked!
    const onlyTlsActive = buildConnectInstructions({
      hostname: "www.batiknusantara.id",
      mode: "zero_downtime_migration",
      sslMethod: "txt",
      provider: makeMigrationProvider({
        status: "pending",
        ssl: { ...makeMigrationProvider().ssl, status: "active" },
      }),
      nowMs: BASE_NOW_MS,
    });
    expect(onlyTlsActive.cnameCutoverLocked).toBe(true);
    expect(onlyTlsActive.readyForCutover).toBe(false);
    expect(onlyTlsActive.validationRecords.some((r) => r.purpose === "routing")).toBe(false);

    // 4. BOTH active -> CNAME cutover UNLOCKED & routing CNAME revealed!
    const bothActive = buildConnectInstructions({
      hostname: "www.batiknusantara.id",
      mode: "zero_downtime_migration",
      sslMethod: "txt",
      provider: makeMigrationProvider({
        status: "active",
        ssl: { ...makeMigrationProvider().ssl, status: "active" },
      }),
      nowMs: BASE_NOW_MS,
    });
    expect(bothActive.cnameCutoverLocked).toBe(false);
    expect(bothActive.readyForCutover).toBe(true);
    expect(bothActive.steps[2]?.locked).toBe(false);
    expect(bothActive.validationRecords).toContainEqual({
      recordType: "CNAME",
      name: "www.batiknusantara.id",
      value: DEFAULT_SAAS_CNAME_TARGET,
      purpose: "routing",
      status: "pending",
      removableAfterActive: false,
    });
  });

  it("evaluates apex capability cleanly and rejects unsupported apex or unconfirmed flattening", () => {
    const validatedApex = validateCustomHostname("batiknusantara.id");
    expect(validatedApex.ok).toBe(true);
    if (!validatedApex.ok) return;
    expect(validatedApex.isLikelyApex).toBe(true);

    const unsupported = evaluateApexCapability({
      hostname: validatedApex.hostname,
      isLikelyApex: validatedApex.isLikelyApex,
      providerSupportsApex: false,
    });
    expect(unsupported.supported).toBe(false);
    expect(unsupported.reasonCode).toBe("APEX_UNSUPPORTED_CAPABILITY");
    expect(unsupported.suggestedWwwHostname).toBe("www.batiknusantara.id");

    const unconfirmed = evaluateApexCapability({
      hostname: validatedApex.hostname,
      isLikelyApex: validatedApex.isLikelyApex,
      confirmApexFlattening: false,
      providerSupportsApex: true,
    });
    expect(unconfirmed.supported).toBe(false);
    expect(unconfirmed.reasonCode).toBe("APEX_FLATTENING_UNCONFIRMED");

    const supported = evaluateApexCapability({
      hostname: validatedApex.hostname,
      isLikelyApex: validatedApex.isLikelyApex,
      connectMode: "new_domain",
      confirmApexFlattening: true,
      providerSupportsApex: true,
    });
    expect(supported.supported).toBe(true);
    expect(supported.reasonCode).toBe("APEX_SUPPORTED");

    // new_domain apex without explicit confirmApexFlattening === true is rejected
    const missingConfirm = evaluateApexCapability({
      hostname: validatedApex.hostname,
      connectMode: "new_domain",
      providerSupportsApex: true,
    });
    expect(missingConfirm.supported).toBe(false);
    expect(missingConfirm.reasonCode).toBe("APEX_FLATTENING_UNCONFIRMED");
  });

  it("detects Indonesian & regional multi-label public suffix apex domains (.co.id, .web.id, .sch.id, etc.) for apex gates and counterpart suggestion", () => {
    const multiLabelApexHosts = [
      "bisnis.co.id",
      "toko.web.id",
      "yayasan.or.id",
      "kampus.ac.id",
      "sekolah.sch.id",
      "pemda.go.id",
      "usaha.my.id",
      "usaha.biz.id",
      "desaku.desa.id",
      "pesantren.ponpes.id",
      "brand.co.uk",
      "brand.com.sg",
      "brand.com.my",
      "brand.com.au",
    ];
    expect(MULTI_LABEL_PUBLIC_SUFFIXES.size).toBeGreaterThanOrEqual(14);

    for (const host of multiLabelApexHosts) {
      expect(isApexDomainHostname(host), `${host} must be detected as apex`).toBe(true);
      const v = validateCustomHostname(host);
      expect(v.ok).toBe(true);
      if (v.ok) {
        expect(v.isLikelyApex).toBe(true);
        expect(v.suggestedWwwCounterpart).toBe(`www.${host}`);
      }
    }

    // Subdomains under multi-label suffixes are NOT apex
    expect(isApexDomainHostname("www.bisnis.co.id")).toBe(false);
    expect(isApexDomainHostname("shop.bisnis.co.id")).toBe(false);

    // Unsupported apex capability rejects bisnis.co.id and suggests www.bisnis.co.id
    const unsupportedCoId = evaluateApexCapability({
      hostname: "bisnis.co.id",
      connectMode: "new_domain",
      confirmApexFlattening: true,
      providerSupportsApex: false,
    });
    expect(unsupportedCoId.supported).toBe(false);
    expect(unsupportedCoId.reasonCode).toBe("APEX_UNSUPPORTED_CAPABILITY");
    expect(unsupportedCoId.suggestedWwwHostname).toBe("www.bisnis.co.id");

    // Counterpart suggestion works cleanly in both directions for bisnis.co.id <-> www.bisnis.co.id
    const capsFromApex = evaluateTenantDomainSetCapabilities([
      {
        id: 2,
        hostname: "bisnis.co.id",
        kind: "custom",
        status: "active",
        sslStatus: "active",
        isPrimary: true,
        isLocked: true,
      },
    ]);
    expect(capsFromApex.suggestedCounterpartHostname).toBe("www.bisnis.co.id");

    const capsFromWww = evaluateTenantDomainSetCapabilities([
      {
        id: 2,
        hostname: "www.bisnis.co.id",
        kind: "custom",
        status: "active",
        sslStatus: "active",
        isPrimary: true,
        isLocked: true,
      },
    ]);
    expect(capsFromWww.suggestedCounterpartHostname).toBe("bisnis.co.id");
  });
});

describe("TASK-039 unit — post-activation lock, counterpart/primary eligibility & cleanup guidance", () => {
  it("locks owner removal once active while keeping counterpart-add and primary-switch eligible", () => {
    const caps = evaluateTenantDomainSetCapabilities([
      {
        id: 1,
        hostname: "batik.situsku.click",
        kind: "subdomain",
        status: "active",
        sslStatus: "active",
        isPrimary: false,
        isLocked: false,
      },
      {
        id: 2,
        hostname: "www.batiknusantara.id",
        kind: "custom",
        status: "active",
        sslStatus: "active",
        isPrimary: true,
        isLocked: true,
      },
    ]);

    expect(caps.customDomainLocked).toBe(true);
    expect(caps.canAddMoreCustomHostnames).toBe(true);
    expect(caps.suggestedCounterpartHostname).toBe("batiknusantara.id");

    const fallbackElig = caps.domains.find((d) => d.id === 1);
    const activeElig = caps.domains.find((d) => d.id === 2);
    expect(fallbackElig?.canMakePrimary).toBe(true);
    expect(fallbackElig?.canOwnerRemove).toBe(false);
    expect(activeElig?.lockedAfterActivation).toBe(true);
    expect(activeElig?.canOwnerRemove).toBe(false);

    // Adding an unactivated counterpart still allows removing the unactivated counterpart
    const withPendingCounterpart = evaluateTenantDomainSetCapabilities([
      {
        id: 1,
        hostname: "batik.situsku.click",
        kind: "subdomain",
        status: "active",
        sslStatus: "active",
        isPrimary: false,
        isLocked: false,
      },
      {
        id: 2,
        hostname: "www.batiknusantara.id",
        kind: "custom",
        status: "active",
        sslStatus: "active",
        isPrimary: true,
        isLocked: true,
      },
      {
        id: 3,
        hostname: "batiknusantara.id",
        kind: "custom",
        status: "pending_verification",
        sslStatus: "pending_validation",
        isPrimary: false,
        isLocked: false,
      },
    ]);
    expect(withPendingCounterpart.canAddMoreCustomHostnames).toBe(false);
    const pendingCounterpartElig = withPendingCounterpart.domains.find((d) => d.id === 3);
    expect(pendingCounterpartElig?.canOwnerRemove).toBe(true);
    expect(pendingCounterpartElig?.canMakePrimary).toBe(false);
  });

  it("produces explicit post-activation cleanup guidance (ownership TXT removable, delegation & routing CNAMEs must stay)", () => {
    const plan = buildConnectInstructions({
      hostname: "www.batiknusantara.id",
      mode: "zero_downtime_migration",
      sslMethod: "txt",
      provider: makeMigrationProvider({
        status: "active",
        ssl: { ...makeMigrationProvider().ssl, status: "active" },
      }),
      dns: { cnameTargets: [DEFAULT_SAAS_CNAME_TARGET] },
      nowMs: BASE_NOW_MS,
    });

    const guidance = buildPostActivationCleanupGuidance({
      hostname: "www.batiknusantara.id",
      mode: "zero_downtime_migration",
      validationRecords: plan.validationRecords,
      cnameTarget: DEFAULT_SAAS_CNAME_TARGET,
    });

    expect(guidance.removable.some((item) => item.purpose === "ownership" && item.recordType === "TXT")).toBe(
      true,
    );
    expect(
      guidance.mustKeep.some(
        (item) => item.purpose === "ssl_dcv" && item.recordType === "CNAME",
      ),
    ).toBe(true);
    expect(
      guidance.mustKeep.some(
        (item) =>
          item.purpose === "routing" &&
          item.recordType === "CNAME" &&
          item.value === DEFAULT_SAAS_CNAME_TARGET,
      ),
    ).toBe(true);
    expect(guidance.summaryId).toContain("TXT kepemilikan boleh dihapus");
    expect(guidance.summaryId).toContain("WAJIB tetap dipertahankan");
  });
});

describe("TASK-039 unit — base-nova & boundary static guards", () => {
  it("contains ZERO @radix-ui/* imports, ZERO asChild props, and ZERO runtime CREATE TABLE DDL in TASK-039 UI & core files", () => {
    const filesToCheck = [
      path.join(REPO_ROOT, "apps/web/src/pages/dashboard/[handle]/settings/domains/index.astro"),
      path.join(REPO_ROOT, "apps/web/src/pages/dashboard/[handle]/settings/domains/_loader.ts"),
      path.join(REPO_ROOT, "apps/web/src/pages/dashboard/[handle]/settings/domains/_types.ts"),
      path.join(
        REPO_ROOT,
        "apps/web/src/pages/dashboard/[handle]/settings/domains/_DomainsManager.tsx",
      ),
      path.join(REPO_ROOT, "packages/core/src/domains/validation.ts"),
      path.join(REPO_ROOT, "packages/core/src/domains/connect-modes.ts"),
    ];

    for (const filePath of filesToCheck) {
      const content = fs.readFileSync(filePath, "utf8");
      expect(content, `${filePath} must never import @radix-ui`).not.toMatch(/@radix-ui\//);
      expect(content, `${filePath} must never use asChild`).not.toMatch(/\basChild\b/);
      expect(content, `${filePath} must never execute runtime CREATE TABLE`).not.toMatch(
        /CREATE\s+TABLE/i,
      );
    }

    const managerSource = fs.readFileSync(
      path.join(
        REPO_ROOT,
        "apps/web/src/pages/dashboard/[handle]/settings/domains/_DomainsManager.tsx",
      ),
      "utf8",
    );
    expect(managerSource).toContain("@base-ui/react/dialog");
  });
});

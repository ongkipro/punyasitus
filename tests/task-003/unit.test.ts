import fs from "node:fs";
import path from "node:path";
import {
  DAY_MS,
  DEFAULT_SAAS_CNAME_TARGET,
  DomainConflictError,
  DomainEligibilityError,
  DomainMarkerConfigError,
  DomainProviderError,
  HOUR_MS,
  MAX_CUSTOM_HOSTNAME_LENGTH,
  assertTenantDomainSetCompatibility,
  assertTenantPaidForCustomDomain,
  buildConnectInstructions,
  computeTenantDomainMarker,
  createCloudflareDohDnsResolver,
  createCloudflareSaasClient,
  createFetchHttpsProbe,
  diagnoseDomainState,
  evaluateDcvTokenAge,
  evaluatePrimaryPromotionGates,
  normalizeConnectMode,
  resolveDomainMarkerSecret,
  resolveSslMethodForMode,
  validateCustomHostname,
  type CloudflareCustomHostname,
} from "@punyasitus/core/domains/index";
import { describe, expect, it } from "vitest";
import {
  CONSENT_COOKIE_NAME,
  parseConsentCookie,
  serializeConsentCookie,
  validateTenantSetCookieHeader,
  withdrawConsent,
} from "../../apps/web/src/core/privacy.ts";
import {
  TENANT_CONSENT_COOKIE_NAME,
  sanitizeTenantResponseHeaders,
} from "../../apps/web/src/core/tenant.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const BASE_NOW_MS = Date.UTC(2026, 4, 1, 12, 0, 0);

function makeProviderHostname(
  overrides: Partial<CloudflareCustomHostname> = {},
): CloudflareCustomHostname {
  return {
    id: "cf-ch-001",
    hostname: "www.tokocontoh.id",
    status: "pending",
    ownership_verification: {
      type: "txt",
      name: "_cf-custom-hostname.www.tokocontoh.id",
      value: "cf-owner-token-from-provider-abc123",
    },
    ssl: {
      id: "cf-ssl-001",
      status: "pending_validation",
      method: "txt",
      type: "dv",
      certificate_authority: "lets_encrypt",
      dcv_delegation_records: [
        {
          cname: "_acme-challenge.www.tokocontoh.id",
          cname_target: "www.tokocontoh.id.dcv-delegate.situsku.click",
        },
      ],
      validation_records: [
        {
          txt_name: "_acme-challenge.www.tokocontoh.id",
          txt_value: "cf-dcv-token-from-provider-xyz789",
        },
      ],
      settings: { min_tls_version: "1.2" },
    },
    ...overrides,
  };
}

describe("TASK-003 unit — hostname validation, eligibility & REQ-065 domain-set rules", () => {
  it("accepts valid custom hostnames and normalizes case and trailing dot", () => {
    const res = validateCustomHostname("  WWW.TokoContoh.ID.  ");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.hostname).toBe("www.tokocontoh.id");
      expect(res.isWww).toBe(true);
      expect(res.apexCounterpart).toBe("tokocontoh.id");
    }

    const exact64 = `${"a".repeat(52)}.tokocontoh.id`; // 52 + 1 + 10 + 1? wait let's construct exact 64
    const label64 = `${"a".repeat(50)}.tokocontoh.id`;
    expect(label64.length).toBe(64);
    expect(validateCustomHostname(label64).ok).toBe(true);
    void exact64;
  });

  it("rejects hostnames > 64 chars (Cloudflare SSL CN Error 1469)", () => {
    const over64 = `${"a".repeat(51)}.tokocontoh.id`;
    expect(over64.length).toBe(MAX_CUSTOM_HOSTNAME_LENGTH + 1);
    const res = validateCustomHostname(over64);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("HOSTNAME_TOO_LONG");
    }
  });

  it("rejects malformed, wildcard, IP, private/reserved, platform, and SaaS zone hostnames", () => {
    const invalidCases: Array<[string, string]> = [
      ["", "HOSTNAME_EMPTY"],
      ["https://www.toko.id", "HOSTNAME_MALFORMED"],
      ["www.toko.id/path", "HOSTNAME_MALFORMED"],
      ["user@www.toko.id", "HOSTNAME_MALFORMED"],
      ["www.toko.id:443", "HOSTNAME_MALFORMED"],
      ["*.toko.id", "HOSTNAME_WILDCARD_FORBIDDEN"],
      ["192.168.1.10", "HOSTNAME_IP_FORBIDDEN"],
      ["127.0.0.1", "HOSTNAME_IP_FORBIDDEN"],
      ["localhost", "HOSTNAME_MALFORMED"],
      ["shop.localhost", "HOSTNAME_PRIVATE_FORBIDDEN"],
      ["printer.local", "HOSTNAME_PRIVATE_FORBIDDEN"],
      ["api.internal", "HOSTNAME_PRIVATE_FORBIDDEN"],
      ["punyasitus.com", "HOSTNAME_PLATFORM_FORBIDDEN"],
      ["app.punyasitus.com", "HOSTNAME_PLATFORM_FORBIDDEN"],
      ["console.punyasitus.com", "HOSTNAME_PLATFORM_FORBIDDEN"],
      ["situsku.click", "HOSTNAME_SAAS_ZONE_FORBIDDEN"],
      ["toko.situsku.click", "HOSTNAME_SAAS_ZONE_FORBIDDEN"],
      ["-bad.toko.id", "HOSTNAME_MALFORMED"],
      ["bad..toko.id", "HOSTNAME_MALFORMED"],
    ];

    for (const [candidate, expectedCode] of invalidCases) {
      const res = validateCustomHostname(candidate);
      expect(res.ok, `Expected "${candidate}" to be rejected`).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe(expectedCode);
      }
    }
  });

  it("rejects trial websites with 403 TRIAL_DOMAIN_FORBIDDEN", () => {
    expect(() => assertTenantPaidForCustomDomain("trial")).toThrowError(DomainEligibilityError);
    try {
      assertTenantPaidForCustomDomain("trial");
    } catch (err) {
      expect(err).toBeInstanceOf(DomainEligibilityError);
      expect((err as DomainEligibilityError).status).toBe(403);
      expect((err as DomainEligibilityError).code).toBe("TRIAL_DOMAIN_FORBIDDEN");
    }
    expect(() => assertTenantPaidForCustomDomain("active")).not.toThrow();
    expect(() => assertTenantPaidForCustomDomain("grace")).not.toThrow();
  });

  it("enforces REQ-065 max 2 custom hostnames and single domain counterpart rule", () => {
    expect(() =>
      assertTenantDomainSetCompatibility(["www.tokocontoh.id"], "tokocontoh.id"),
    ).not.toThrow();
    expect(() =>
      assertTenantDomainSetCompatibility(["tokocontoh.id"], "www.tokocontoh.id"),
    ).not.toThrow();
    // Unrelated domain rejected
    expect(() =>
      assertTenantDomainSetCompatibility(["www.tokocontoh.id"], "www.tokolain.id"),
    ).toThrowError(DomainConflictError);
    // 3rd custom hostname rejected
    expect(() =>
      assertTenantDomainSetCompatibility(
        ["www.tokocontoh.id", "tokocontoh.id"],
        "shop.tokocontoh.id",
      ),
    ).toThrowError(DomainConflictError);
  });

  it("normalizes connect modes including 'o2o' alias and validates sslMethod constraints", () => {
    expect(normalizeConnectMode("new_domain")).toBe("new_domain");
    expect(normalizeConnectMode("zero_downtime_migration")).toBe("zero_downtime_migration");
    expect(normalizeConnectMode("cloudflare_o2o")).toBe("cloudflare_o2o");
    expect(normalizeConnectMode("o2o")).toBe("cloudflare_o2o");

    expect(resolveSslMethodForMode("new_domain")).toBe("http");
    expect(resolveSslMethodForMode("zero_downtime_migration")).toBe("txt");
    expect(resolveSslMethodForMode("cloudflare_o2o")).toBe("http");
    expect(() => resolveSslMethodForMode("zero_downtime_migration", "http")).toThrow();
    expect(() => resolveSslMethodForMode("cloudflare_o2o", "txt")).toThrow();
  });
});

describe("TASK-003 unit — 3 connect modes (PLAN §3.2), token age & remedies", () => {
  it("Mode A (new_domain): emits routing CNAME strictly from configured target", () => {
    const provider = makeProviderHostname({
      ssl: {
        status: "pending_validation",
        method: "http",
        type: "dv",
        certificate_authority: "lets_encrypt",
      },
    });
    const plan = buildConnectInstructions({
      hostname: "www.tokocontoh.id",
      mode: "new_domain",
      sslMethod: "http",
      provider,
      nowMs: BASE_NOW_MS,
    });

    expect(plan.mode).toBe("new_domain");
    expect(plan.createBeforeCnameSatisfied).toBe(true);
    expect(plan.cnameCutoverLocked).toBe(false);
    expect(plan.validationRecords).toEqual([
      {
        recordType: "CNAME",
        name: "www.tokocontoh.id",
        value: DEFAULT_SAAS_CNAME_TARGET,
        purpose: "routing",
        status: "pending",
        removableAfterActive: false,
      },
    ]);
  });

  it("Mode B (zero_downtime_migration): emits exact provider tokens only and keeps CNAME cutover LOCKED until BOTH status and ssl.status are active", () => {
    // 1. Both pending -> LOCKED
    const pendingPlan = buildConnectInstructions({
      hostname: "www.tokocontoh.id",
      mode: "zero_downtime_migration",
      sslMethod: "txt",
      provider: makeProviderHostname({ status: "pending" }),
      nowMs: BASE_NOW_MS,
    });
    expect(pendingPlan.cnameCutoverLocked).toBe(true);
    expect(pendingPlan.readyForCutover).toBe(false);
    expect(pendingPlan.steps[2]?.locked).toBe(true);
    expect(pendingPlan.steps[2]?.records).toHaveLength(0);
    expect(pendingPlan.validationRecords.some((r) => r.purpose === "routing")).toBe(false);
    expect(pendingPlan.validationRecords).toContainEqual({
      recordType: "TXT",
      name: "_cf-custom-hostname.www.tokocontoh.id",
      value: "cf-owner-token-from-provider-abc123",
      purpose: "ownership",
      status: "pending",
      removableAfterActive: true,
    });
    expect(pendingPlan.validationRecords).toContainEqual({
      recordType: "CNAME",
      name: "_acme-challenge.www.tokocontoh.id",
      value: "www.tokocontoh.id.dcv-delegate.situsku.click",
      purpose: "ssl_dcv",
      status: "pending",
      removableAfterActive: false,
    });

    // 2. Ownership active, SSL still pending -> STILL LOCKED!
    const halfReadyPlan = buildConnectInstructions({
      hostname: "www.tokocontoh.id",
      mode: "zero_downtime_migration",
      sslMethod: "txt",
      provider: makeProviderHostname({
        status: "active",
        ssl: { ...makeProviderHostname().ssl, status: "pending_validation" },
      }),
      nowMs: BASE_NOW_MS,
    });
    expect(halfReadyPlan.cnameCutoverLocked).toBe(true);
    expect(halfReadyPlan.steps[2]?.locked).toBe(true);
    expect(halfReadyPlan.validationRecords.some((r) => r.purpose === "routing")).toBe(false);

    // 3. SSL active, ownership still pending -> STILL LOCKED!
    const reverseHalfPlan = buildConnectInstructions({
      hostname: "www.tokocontoh.id",
      mode: "zero_downtime_migration",
      sslMethod: "txt",
      provider: makeProviderHostname({
        status: "pending",
        ssl: { ...makeProviderHostname().ssl, status: "active" },
      }),
      nowMs: BASE_NOW_MS,
    });
    expect(reverseHalfPlan.cnameCutoverLocked).toBe(true);
    expect(reverseHalfPlan.steps[2]?.locked).toBe(true);

    // 4. Empty provider tokens -> NEVER fabricates tokens!
    const noTokenPlan = buildConnectInstructions({
      hostname: "www.tokocontoh.id",
      mode: "zero_downtime_migration",
      sslMethod: "txt",
      provider: {
        id: "cf-ch-empty",
        hostname: "www.tokocontoh.id",
        status: "pending",
        ssl: { status: "pending_validation", method: "txt", type: "dv" },
      },
      nowMs: BASE_NOW_MS,
    });
    expect(noTokenPlan.awaitingProviderTokens).toBe(true);
    expect(noTokenPlan.validationRecords).toHaveLength(0);

    // 5. BOTH status === "active" AND ssl.status === "active" -> UNLOCKED!
    const unlockedPlan = buildConnectInstructions({
      hostname: "www.tokocontoh.id",
      mode: "zero_downtime_migration",
      sslMethod: "txt",
      provider: makeProviderHostname({
        status: "active",
        ssl: { ...makeProviderHostname().ssl, status: "active" },
      }),
      nowMs: BASE_NOW_MS,
    });
    expect(unlockedPlan.cnameCutoverLocked).toBe(false);
    expect(unlockedPlan.readyForCutover).toBe(true);
    expect(unlockedPlan.steps[2]?.locked).toBe(false);
    expect(unlockedPlan.steps[2]?.records).toEqual([
      {
        recordType: "CNAME",
        name: "www.tokocontoh.id",
        value: DEFAULT_SAAS_CNAME_TARGET,
        purpose: "routing",
        status: "pending",
        removableAfterActive: false,
      },
    ]);
  });

  it("Mode C (cloudflare_o2o): enforces create-before-CNAME and emits Full/Full (strict) guidance", () => {
    // Before Cloudflare hostname is created -> CNAME step is locked!
    const beforeCreate = buildConnectInstructions({
      hostname: "www.tokocontoh.id",
      mode: "cloudflare_o2o",
      sslMethod: "http",
      provider: null,
      nowMs: BASE_NOW_MS,
    });
    expect(beforeCreate.createBeforeCnameSatisfied).toBe(false);
    expect(beforeCreate.cnameCutoverLocked).toBe(true);
    expect(beforeCreate.validationRecords).toHaveLength(0);

    // After Cloudflare hostname is created -> emits proxied CNAME + O2O SSL remedy
    const afterCreate = buildConnectInstructions({
      hostname: "www.tokocontoh.id",
      mode: "cloudflare_o2o",
      sslMethod: "http",
      provider: makeProviderHostname({
        ssl: { status: "pending_validation", method: "http", type: "dv" },
      }),
      nowMs: BASE_NOW_MS,
    });
    expect(afterCreate.createBeforeCnameSatisfied).toBe(true);
    expect(afterCreate.cnameCutoverLocked).toBe(false);
    expect(afterCreate.validationRecords).toHaveLength(1);
    expect(afterCreate.remedies.some((r) => r.code === "O2O_SSL_MODE_REMINDER")).toBe(true);
  });

  it("computes DCV token age, day-5 warning, and CA-specific expiry (LE 7d, GTS & SSL.com 14d)", () => {
    // Let's Encrypt: 7 days
    const leDay4 = evaluateDcvTokenAge({
      certificateAuthority: "lets_encrypt",
      issuedAtMs: BASE_NOW_MS,
      nowMs: BASE_NOW_MS + 4 * DAY_MS,
    });
    expect(leDay4.ttlDays).toBe(7);
    expect(leDay4.warningDay5).toBe(false);
    expect(leDay4.expired).toBe(false);

    const leDay5 = evaluateDcvTokenAge({
      certificateAuthority: "lets_encrypt",
      issuedAtMs: BASE_NOW_MS,
      nowMs: BASE_NOW_MS + 5 * DAY_MS,
    });
    expect(leDay5.warningDay5).toBe(true);
    expect(leDay5.expired).toBe(false);
    expect(leDay5.warningMessageId).toContain("hari ke-5");

    const leDay7 = evaluateDcvTokenAge({
      certificateAuthority: "lets_encrypt",
      issuedAtMs: BASE_NOW_MS,
      nowMs: BASE_NOW_MS + 7 * DAY_MS,
    });
    expect(leDay7.expired).toBe(true);
    expect(leDay7.needsRefetch).toBe(true);

    // Google Trust Services: 14 days
    const gtsDay8 = evaluateDcvTokenAge({
      certificateAuthority: "google",
      issuedAtMs: BASE_NOW_MS,
      nowMs: BASE_NOW_MS + 8 * DAY_MS,
    });
    expect(gtsDay8.ttlDays).toBe(14);
    expect(gtsDay8.warningDay5).toBe(true);
    expect(gtsDay8.expired).toBe(false);

    const gtsDay14 = evaluateDcvTokenAge({
      certificateAuthority: "google",
      issuedAtMs: BASE_NOW_MS,
      nowMs: BASE_NOW_MS + 14 * DAY_MS,
    });
    expect(gtsDay14.expired).toBe(true);
    expect(gtsDay14.needsRefetch).toBe(true);

    // SSL.com: 14 days
    const sslComDay13 = evaluateDcvTokenAge({
      certificateAuthority: "ssl_com",
      issuedAtMs: BASE_NOW_MS,
      nowMs: BASE_NOW_MS + 13 * DAY_MS + 23 * HOUR_MS,
    });
    expect(sslComDay13.ttlDays).toBe(14);
    expect(sslComDay13.warningDay5).toBe(true);
    expect(sslComDay13.expired).toBe(false);

    const sslComDay14 = evaluateDcvTokenAge({
      certificateAuthority: "ssl_com",
      issuedAtMs: BASE_NOW_MS,
      nowMs: BASE_NOW_MS + 14 * DAY_MS,
    });
    expect(sslComDay14.expired).toBe(true);
  });

  it("diagnoses conflicting _acme-challenge TXT, CAA block, Blocked zone hold, Moved, and HTTP DCV blocked", () => {
    const provider = makeProviderHostname({
      status: "blocked",
      ssl: {
        ...makeProviderHostname().ssl,
        method: "http",
        status: "validation_timed_out",
        validation_errors: [
          { message: "CAA record prevents issuance for letsencrypt.org" },
          { message: "HTTP challenge returned 403 Forbidden (WAF)" },
        ],
      },
    });

    const remedies = diagnoseDomainState({
      hostname: "www.tokocontoh.id",
      mode: "zero_downtime_migration",
      provider,
      dns: {
        acmeChallengeTxtRecords: ["old-stale-acme-txt-value"],
        caaRecords: ['0 issue "sectigo.com"'],
      },
    });

    const codes = remedies.map((r) => r.code);
    expect(codes).toContain("CONFLICTING_ACME_CHALLENGE_TXT");
    expect(codes).toContain("CAA_BLOCKED");
    expect(codes).toContain("HOSTNAME_BLOCKED");
    expect(codes).toContain("HTTP_DCV_BLOCKED");

    const acmeRemedy = remedies.find((r) => r.code === "CONFLICTING_ACME_CHALLENGE_TXT");
    expect(acmeRemedy?.affectedRecord).toBe("_acme-challenge.www.tokocontoh.id");
    expect(acmeRemedy?.conflictingValues).toEqual(["old-stale-acme-txt-value"]);
  });
});

describe("TASK-003 unit — 4-gate primary promotion & Cloudflare client", () => {
  it("blocks primary promotion whenever ANY of the 4 gates fails and passes only when all 4 pass", async () => {
    const marker = await computeTenantDomainMarker(
      "01JTENANT00000000000000001",
      "www.tokocontoh.id",
      "test-marker-secret-0123456789abcdef0123456789",
    );
    expect(marker).toContain("ps-v1:01JTENANT00000000000000001:");

    const okProbe = {
      ok: true,
      statusCode: 200,
      observedTenantId: "01JTENANT00000000000000001",
      markerMatched: true,
      errorCode: null,
    } as const;

    // Gate 1 fail
    expect(
      evaluatePrimaryPromotionGates({
        providerStatus: "pending",
        providerSslStatus: "active",
        observedCnameTargets: [DEFAULT_SAAS_CNAME_TARGET],
        httpsProbe: okProbe,
        expectedTenantId: "01JTENANT00000000000000001",
      }).eligible,
    ).toBe(false);

    // Gate 2 fail
    expect(
      evaluatePrimaryPromotionGates({
        providerStatus: "active",
        providerSslStatus: "pending_validation",
        observedCnameTargets: [DEFAULT_SAAS_CNAME_TARGET],
        httpsProbe: okProbe,
        expectedTenantId: "01JTENANT00000000000000001",
      }).eligible,
    ).toBe(false);

    // Gate 3 fail
    expect(
      evaluatePrimaryPromotionGates({
        providerStatus: "active",
        providerSslStatus: "active",
        observedCnameTargets: ["other-host.example.net"],
        httpsProbe: okProbe,
        expectedTenantId: "01JTENANT00000000000000001",
      }).eligible,
    ).toBe(false);

    // Gate 4 fail (wrong tenant answers!)
    expect(
      evaluatePrimaryPromotionGates({
        providerStatus: "active",
        providerSslStatus: "active",
        observedCnameTargets: [DEFAULT_SAAS_CNAME_TARGET],
        httpsProbe: {
          ok: true,
          statusCode: 200,
          observedTenantId: "01JOTHTENANT00000000000002",
          markerMatched: true,
          errorCode: null,
        },
        expectedTenantId: "01JTENANT00000000000000001",
      }).eligible,
    ).toBe(false);

    // All 4 pass!
    const allPass = evaluatePrimaryPromotionGates({
      providerStatus: "active",
      providerSslStatus: "active",
      observedCnameTargets: [DEFAULT_SAAS_CNAME_TARGET],
      httpsProbe: okProbe,
      expectedTenantId: "01JTENANT00000000000000001",
    });
    expect(allPass.eligible).toBe(true);
    expect(allPass.failedGates).toHaveLength(0);
  });

  it("Cloudflare client refetches GET after POST when validation_records is empty, sends PATCH ssl, handles timeout without leaking token", async () => {
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    const secretToken = "cf_secret_token_never_leak_987654";

    const client = createCloudflareSaasClient({
      zoneId: "zone-test-01",
      apiToken: secretToken,
      fetchImpl: async (input, init) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ method, url, body });

        if (method === "POST" && url.endsWith("/custom_hostnames")) {
          // Simulate Cloudflare initially returning empty validation_records
          return new Response(
            JSON.stringify({
              success: true,
              result: {
                id: "cf-ch-999",
                hostname: "www.tokocontoh.id",
                status: "pending",
                ssl: { status: "pending_validation", method: "txt", type: "dv" },
              },
            }),
            { status: 201 },
          );
        }
        if (method === "GET" && url.endsWith("/custom_hostnames/cf-ch-999")) {
          return new Response(
            JSON.stringify({
              success: true,
              result: makeProviderHostname({ id: "cf-ch-999" }),
            }),
            { status: 200 },
          );
        }
        if (method === "PATCH" && url.endsWith("/custom_hostnames/cf-ch-999")) {
          return new Response(
            JSON.stringify({
              success: true,
              result: makeProviderHostname({ id: "cf-ch-999" }),
            }),
            { status: 200 },
          );
        }
        if (method === "DELETE" && url.endsWith("/custom_hostnames/cf-missing")) {
          return new Response(
            JSON.stringify({ success: false, errors: [{ code: 1436, message: "Not found" }] }),
            { status: 404 },
          );
        }
        throw new DOMException("Request timed out", "AbortError");
      },
    });

    const created = await client.createCustomHostname({
      hostname: "www.tokocontoh.id",
      sslMethod: "txt",
    });
    expect(created.id).toBe("cf-ch-999");
    expect(created.ssl.validation_records?.length).toBe(1);
    expect(calls.map((c) => c.method)).toEqual(["POST", "GET"]);

    await client.patchCustomHostnameSsl("cf-ch-999", { method: "txt", minTlsVersion: "1.2" });
    expect(calls[2]?.method).toBe("PATCH");
    expect(calls[2]?.body).toEqual({
      ssl: { method: "txt", type: "dv", settings: { min_tls_version: "1.2" } },
    });

    // Idempotent 404 delete
    const del = await client.deleteCustomHostname("cf-missing");
    expect(del).toEqual({ id: "cf-missing", deleted: true, alreadyAbsent: true });

    // Timeout error is retryable and never leaks token
    try {
      await client.getCustomHostname("cf-timeout");
      expect.fail("Expected timeout error");
    } catch (err) {
      expect(err).toBeInstanceOf(DomainProviderError);
      const pe = err as DomainProviderError;
      expect(pe.kind).toBe("timeout");
      expect(pe.retryable).toBe(true);
      expect(pe.message).not.toContain(secretToken);
    }

    // Default fetch-based HTTPS marker probe
    const expectedMarker = await computeTenantDomainMarker(
      "t1",
      "www.tokocontoh.id",
      "test-marker-secret-0123456789abcdef0123456789",
    );
    const probe = createFetchHttpsProbe({
      fetchImpl: async () =>
        new Response(JSON.stringify({ tenantId: "t1", marker: expectedMarker }), { status: 200 }),
    });
    const probeRes = await probe.probeTenantMarker({
      hostname: "www.tokocontoh.id",
      expectedTenantId: "t1",
      expectedMarker,
    });
    expect(probeRes.ok).toBe(true);
    expect(probeRes.markerMatched).toBe(true);
  });

  it("Cloudflare DoH DNS resolver queries CNAME/TXT/CAA with Accept: application/dns-json and handles errors/timeouts cleanly", async () => {
    const requestedUrls: string[] = [];
    const requestedAccepts: string[] = [];

    const resolver = createCloudflareDohDnsResolver(async (input, init) => {
      const url = new URL(String(input));
      requestedUrls.push(url.toString());
      const headers = new Headers(init?.headers);
      requestedAccepts.push(headers.get("Accept") ?? "");

      const name = url.searchParams.get("name");
      const type = url.searchParams.get("type");

      if (name === "timeout.toko.id") {
        throw new DOMException("Timeout", "AbortError");
      }
      if (name === "nx.toko.id") {
        return new Response(JSON.stringify({ Status: 3 }), { status: 200 });
      }
      if (type === "CNAME") {
        return new Response(
          JSON.stringify({
            Status: 0,
            Answer: [
              { name: "www.tokocontoh.id.", type: 5, data: "CNAME.Situsku.Click." },
              { name: "www.tokocontoh.id.", type: 1, data: "1.2.3.4" }, // non-CNAME ignored
            ],
          }),
          { status: 200 },
        );
      }
      if (type === "TXT") {
        return new Response(
          JSON.stringify({
            Status: 0,
            Answer: [
              {
                name: "_acme-challenge.www.tokocontoh.id.",
                type: 16,
                data: '"part1-" "part2-token"',
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (type === "CAA") {
        return new Response(
          JSON.stringify({
            Status: 0,
            Answer: [{ name: "tokocontoh.id.", type: 257, data: '0 issue "letsencrypt.org"' }],
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ Status: 0, Answer: [] }), { status: 200 });
    });

    expect(await resolver.resolveCname("WWW.TokoContoh.ID.")).toEqual(["cname.situsku.click"]);
    expect(await resolver.resolveTxt("_acme-challenge.www.tokocontoh.id")).toEqual([
      "part1-part2-token",
    ]);
    expect(await resolver.resolveCaa?.("tokocontoh.id")).toEqual(['0 issue "letsencrypt.org"']);
    expect(await resolver.resolveCname("nx.toko.id")).toEqual([]);
    expect(await resolver.resolveCname("timeout.toko.id")).toEqual([]);
    expect(requestedAccepts.every((a) => a === "application/dns-json")).toBe(true);
    expect(requestedUrls[0]).toContain("https://cloudflare-dns.com/dns-query?name=www.tokocontoh.id&type=CNAME");
  });

  it("resolveDomainMarkerSecret fails closed with 503 DOMAIN_MARKER_SECRET_UNCONFIGURED when missing/short outside local/test and never falls back to AUTH_SECRET", () => {
    const validSecret = "a".repeat(32);
    expect(
      resolveDomainMarkerSecret({ APP_ENV: "production", DOMAIN_MARKER_SECRET: validSecret }),
    ).toBe(validSecret);

    // Production without DOMAIN_MARKER_SECRET -> 503 DOMAIN_MARKER_SECRET_UNCONFIGURED (even if testMarkerSecret passed!)
    try {
      resolveDomainMarkerSecret(
        { APP_ENV: "production" },
        { testMarkerSecret: validSecret },
      );
      expect.fail("Expected DomainMarkerConfigError in production");
    } catch (err) {
      expect(err).toBeInstanceOf(DomainMarkerConfigError);
      expect((err as DomainMarkerConfigError).status).toBe(503);
      expect((err as DomainMarkerConfigError).reasonCode).toBe(
        "DOMAIN_MARKER_SECRET_UNCONFIGURED",
      );
    }

    // Short secret (< 32 chars) -> fails closed
    expect(() =>
      resolveDomainMarkerSecret({ APP_ENV: "production", DOMAIN_MARKER_SECRET: "too-short" }),
    ).toThrowError(DomainMarkerConfigError);

    // Local/test allows explicit testMarkerSecret injection only
    expect(
      resolveDomainMarkerSecret({ APP_ENV: "test" }, { testMarkerSecret: validSecret }),
    ).toBe(validSecret);
    expect(() => resolveDomainMarkerSecret({ APP_ENV: "test" })).toThrowError(
      DomainMarkerConfigError,
    );
  });
});

// ---------------------------------------------------------------------------
// EXPLICIT TASK-003 INVARIANT: Tenant-Host Cookie Isolation Audit (PLAN §3.2)
// ---------------------------------------------------------------------------

function walkFiles(dirPath: string, exts: ReadonlySet<string>, acc: string[] = []): string[] {
  if (!fs.existsSync(dirPath)) return acc;
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".astro") continue;
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      walkFiles(full, exts, acc);
    } else if (exts.has(path.extname(entry.name))) {
      acc.push(full);
    }
  }
  return acc;
}

/**
 * Inspects tenant-host source code to enforce PLAN §3.2 PSL-free cookie isolation:
 * 1. Never sets `Domain=` in any cookie header or `document.cookie` assignment.
 * 2. Any consent cookie MUST use the `__Host-` prefix (`__Host-ps_consent`).
 * 3. Tenant-host code reads NO cookie other than `__Host-ps_consent`.
 */
function auditTenantHostCookieSource(relPath: string, source: string): string[] {
  const violations: string[] = [];

  // 1. Check any literal cookie assignment containing `Domain=`
  const setCookieDomainRe =
    /(?:document\.cookie\s*=|set-cookie['"]?\s*[,:]|serializeConsentCookie)[\s\S]{0,240}\bdomain\s*=/gi;
  if (setCookieDomainRe.test(source)) {
    violations.push(`${relPath}: sets a cookie with forbidden Domain= attribute on tenant host`);
  }

  // 2. Check any consent cookie literal lacking `__Host-` prefix
  const consentCookieConstRe =
    /(?:CONSENT_COOKIE_NAME|cookieName)\s*(?:=|\|\|)\s*["']([^"']+)["']/g;
  for (const match of source.matchAll(consentCookieConstRe)) {
    const cookieName = match[1] ?? "";
    if (!cookieName.startsWith("__Host-")) {
      violations.push(
        `${relPath}: consent cookie "${cookieName}" lacks mandatory "__Host-" prefix`,
      );
    }
  }

  // 3. Check `cookies.get(...)` / `cookies.has(...)` / `cookies.getAll(...)` / destructured `cookies` reads
  const astroCookiesMethodRe = /cookies\.(get|has)\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of source.matchAll(astroCookiesMethodRe)) {
    const name = match[2] ?? "";
    if (name !== CONSENT_COOKIE_NAME) {
      violations.push(
        `${relPath}: tenant-host code reads forbidden cookie "${name}" via cookies.${match[1]}() (only ${CONSENT_COOKIE_NAME} is allowed)`,
      );
    }
  }
  if (/cookies\.getAll\s*\(/g.test(source)) {
    violations.push(`${relPath}: tenant-host code calls forbidden cookies.getAll()`);
  }
  if (/(?:const|let|var)\s*\{[^}]*\b(?:get|has|getAll)\b[^}]*\}\s*=\s*(?:Astro|context|locals)\.cookies\b/.test(source)) {
    violations.push(`${relPath}: tenant-host code destructures cookies accessor (may read non-consent cookies)`);
  }

  // 4. Check raw `headers.get("cookie")` reads in tenant-host files outside consent/cache bypass helpers
  if (
    /headers\.get\(\s*["']cookie["']\s*\)/i.test(source) &&
    !source.includes(CONSENT_COOKIE_NAME)
  ) {
    violations.push(
      `${relPath}: reads request Cookie header without scoping strictly to ${CONSENT_COOKIE_NAME}`,
    );
  }

  return violations;
}

describe("TASK-003 invariant — tenant-host cookie isolation (PLAN §3.2 PSL-free guard)", () => {
  it("enforces __Host-ps_consent prefix and forbids Domain= on tenant consent serialization & sanitization", () => {
    expect(CONSENT_COOKIE_NAME).toBe("__Host-ps_consent");
    expect(TENANT_CONSENT_COOKIE_NAME).toBe("__Host-ps_consent");

    const setCookie = serializeConsentCookie({
      version: 1,
      analytics: true,
      marketing: false,
      maps: false,
      updatedAt: "2026-05-01T12:00:00.000Z",
    });
    expect(setCookie.startsWith("__Host-ps_consent=")).toBe(true);
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toContain("Secure");
    expect(setCookie.toLowerCase()).not.toContain("domain=");
    expect(validateTenantSetCookieHeader(setCookie).valid).toBe(true);

    // Rejects consent cookie without __Host- prefix
    expect(() =>
      serializeConsentCookie(
        {
          version: 1,
          analytics: false,
          marketing: false,
          maps: false,
          updatedAt: "2026-05-01T12:00:00.000Z",
        },
        { cookieName: "ps_consent" },
      ),
    ).toThrow();

    // Rejects Domain= in validation and strips Domain= in sanitizeTenantResponseHeaders
    const badCheck = validateTenantSetCookieHeader(
      "__Host-ps_consent=abc; Path=/; Secure; Domain=situsku.click",
    );
    expect(badCheck.valid).toBe(false);
    expect(badCheck.violations).toContain("FORBIDDEN_DOMAIN_ATTRIBUTE");

    const missingPrefixCheck = validateTenantSetCookieHeader("ps_consent=abc; Path=/; Secure");
    expect(missingPrefixCheck.valid).toBe(false);
    expect(missingPrefixCheck.violations).toContain("MISSING_HOST_PREFIX");

    // Withdrawal preserves __Host- and no Domain=
    const withdrawn = withdrawConsent({ now: new Date(BASE_NOW_MS) });
    expect(withdrawn.setCookie.startsWith("__Host-ps_consent=")).toBe(true);
    expect(withdrawn.setCookie.toLowerCase()).not.toContain("domain=");

    // Tenant response sanitizer strips ANY Set-Cookie with Domain=
    const leaked = new Response("ok", {
      headers: [
        ["Set-Cookie", "__Host-ps_consent=valid; Path=/; Secure; SameSite=Lax"],
        ["Set-Cookie", "tossed=evil; Path=/; Domain=situsku.click"],
      ],
    });
    const sanitized = sanitizeTenantResponseHeaders(leaked, { surface: "tenant" });
    const sanitizedCookies = sanitized.headers.getSetCookie();
    expect(sanitizedCookies).toHaveLength(1);
    expect(sanitizedCookies[0]).toContain("__Host-ps_consent=");
    expect(sanitizedCookies.some((c) => /domain=/i.test(c))).toBe(false);

    // parseConsentCookie ignores sibling/unrelated cookies and reads ONLY __Host-ps_consent
    const parsed = parseConsentCookie(
      "session_id=forged; tossed_cookie=1; __Host-ps_consent=%7B%22version%22%3A1%2C%22analytics%22%3Atrue%2C%22marketing%22%3Afalse%2C%22maps%22%3Afalse%2C%22updatedAt%22%3A%222026-05-01T12%3A00%3A00.000Z%22%7D",
    );
    expect(parsed.hasDecision).toBe(true);
    expect(parsed.preferences.analytics).toBe(true);
    expect(parseConsentCookie("session_id=forged; ps_consent=1").hasDecision).toBe(false);
  });

  it("audits all tenant-host source files and fails if any sets Domain=, drops __Host-, or reads another cookie", () => {
    const exts = new Set([".ts", ".tsx", ".astro", ".js", ".mjs"]);
    const tenantFiles = [
      ...walkFiles(path.join(REPO_ROOT, "apps/web/src/themes"), exts),
      ...walkFiles(path.join(REPO_ROOT, "apps/web/src/pages/.well-known"), exts),
      path.join(REPO_ROOT, "apps/web/src/components/Consent.astro"),
      path.join(REPO_ROOT, "apps/web/src/core/privacy.ts"),
      path.join(REPO_ROOT, "apps/web/src/core/public-data.ts"),
      path.join(REPO_ROOT, "apps/web/src/core/public-input.ts"),
      path.join(REPO_ROOT, "apps/web/src/core/tenant.ts"),
      path.join(REPO_ROOT, "apps/web/src/core/cache.ts"),
      path.join(REPO_ROOT, "apps/web/src/pages/index.astro"),
      path.join(REPO_ROOT, "apps/web/src/pages/api/events.ts"),
    ].filter((p) => fs.existsSync(p));

    expect(tenantFiles.length).toBeGreaterThan(6);

    const allViolations: string[] = [];
    for (const filePath of tenantFiles) {
      const content = fs.readFileSync(filePath, "utf8");
      const rel = path.relative(REPO_ROOT, filePath);
      allViolations.push(...auditTenantHostCookieSource(rel, content));
    }

    // Verify middleware (`apps/web/src/middleware/auth.ts`) explicitly bypasses cookie reading on tenant surface
    const authMiddlewarePath = path.join(REPO_ROOT, "apps/web/src/middleware/auth.ts");
    const authMiddlewareSrc = fs.readFileSync(authMiddlewarePath, "utf8");
    const tenantBypassIdx = authMiddlewareSrc.indexOf('surface !== "app" && surface !== "console"');
    const cookieReadIdx = authMiddlewareSrc.indexOf('headers.get("cookie")');
    expect(tenantBypassIdx).toBeGreaterThan(-1);
    expect(cookieReadIdx).toBeGreaterThan(tenantBypassIdx);

    expect(allViolations).toEqual([]);

    // Prove the auditor actually catches all forbidden patterns
    expect(
      auditTenantHostCookieSource(
        "synthetic.ts",
        'document.cookie = "__Host-ps_consent=1; Path=/; Domain=situsku.click";',
      ).length,
    ).toBeGreaterThan(0);
    expect(
      auditTenantHostCookieSource("synthetic.ts", 'const cookieName = "ps_consent";').length,
    ).toBeGreaterThan(0);
    expect(
      auditTenantHostCookieSource("synthetic.ts", 'const s = Astro.cookies.get("__Host-ps_session");')
        .length,
    ).toBeGreaterThan(0);
    expect(
      auditTenantHostCookieSource("synthetic.ts", 'const has = Astro.cookies.has("session");')
        .length,
    ).toBeGreaterThan(0);
    expect(
      auditTenantHostCookieSource("synthetic.ts", "const all = Astro.cookies.getAll();").length,
    ).toBeGreaterThan(0);
    expect(
      auditTenantHostCookieSource("synthetic.ts", "const { get } = Astro.cookies;").length,
    ).toBeGreaterThan(0);
  });
});

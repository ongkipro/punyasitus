import fs from "node:fs";
import path from "node:path";
import type { AuthorizedTenantMember } from "@punyasitus/auth";
import type { TenantStatus } from "@punyasitus/db/platform";
import { describe, expect, it } from "vitest";
import {
  DNS_EMAIL_PATHS,
  DNS_PRESERVATION_ITEMS,
  OFFICIAL_PROVIDER_HOSTS,
  getAllGuideOfficialLinks,
  isOfficialProviderUrl,
} from "../../apps/web/src/components/admin/domain-guide/guide-data.ts";
import { loadDomainGuidePage } from "../../apps/web/src/pages/dashboard/[handle]/settings/domains/_loader.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

function createTrackingMockDb(metaRow: {
  vertical: string;
  operator_hold_reason: string | null;
  trial_ends_at: number | null;
} | null = { vertical: "catalog", operator_hold_reason: null, trial_ends_at: null }) {
  const executedSql: string[] = [];
  const db = {
    prepare(sql: string) {
      executedSql.push(sql);
      return {
        bind() {
          return {
            async first() {
              if (sql.includes("FROM tenants")) {
                return metaRow;
              }
              return null;
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  return { db, executedSql };
}

function makeMember(
  role: AuthorizedTenantMember["role"],
  tenantStatus: TenantStatus,
  handle = "batik-nusantara",
): AuthorizedTenantMember {
  const dbRole: AuthorizedTenantMember["dbRole"] =
    role === "agency_admin"
      ? "agency_staff"
      : role === "owner" || role === "admin" || role === "editor"
        ? role
        : "editor";
  return {
    memberId: `mem-${role}`,
    userId: `usr-${role}`,
    tenantId: "01JT070UNIT000000000000001",
    organizationId: "org-t070-01",
    handle,
    tenantName: "Batik Nusantara",
    tenantStatus,
    dbRole,
    role,
  };
}

describe("TASK-070 unit — domain & business email guide data & link invariants (REQ-071)", () => {
  it("defines exactly the three required DNS email paths per PLAN §18.2", () => {
    expect(DNS_EMAIL_PATHS.map((p) => p.id)).toEqual([
      "cloudflare_dns",
      "registrar_forwarding",
      "paid_mailbox",
    ]);

    const cfPath = DNS_EMAIL_PATHS.find((p) => p.id === "cloudflare_dns");
    expect(cfPath?.requirementCallout?.testId).toBe("cloudflare-dns-requirement");
    expect(cfPath?.requirementCallout?.title).toContain("Cloudflare DNS");
    expect(cfPath?.requirementCallout?.body).toMatch(/Cloudflare Email Routing.*Cloudflare DNS/i);
  });

  it("links exclusively to official HTTPS provider documentation pages with zero query/affiliate params", () => {
    const links = getAllGuideOfficialLinks();
    expect(links.length).toBeGreaterThanOrEqual(8);

    for (const link of links) {
      expect(isOfficialProviderUrl(link.href), `Link must be an official provider HTTPS URL: ${link.href}`).toBe(
        true,
      );
      const parsed = new URL(link.href);
      expect(parsed.protocol).toBe("https:");
      expect(parsed.search).toBe("");
      expect(OFFICIAL_PROVIDER_HOSTS.has(parsed.hostname)).toBe(true);
    }

    // Negative URL checks
    expect(isOfficialProviderUrl("http://developers.cloudflare.com/email-routing/")).toBe(false);
    expect(isOfficialProviderUrl("https://developers.cloudflare.com/email-routing/?ref=aff")).toBe(false);
    expect(isOfficialProviderUrl("https://random-blog.example.com/setup-email")).toBe(false);
    expect(isOfficialProviderUrl("javascript:alert(1)")).toBe(false);
  });

  it("reminds users to preserve MX, SPF, DKIM, and DMARC records when adding the website CNAME", () => {
    const joined = DNS_PRESERVATION_ITEMS.map((i) => i.recordType).join(" ");
    expect(joined).toContain("MX");
    expect(joined).toContain("SPF");
    expect(joined).toContain("DKIM");
    expect(joined).toContain("DMARC");
  });
});

describe("TASK-070 unit — loadDomainGuidePage access & lifecycle gating", () => {
  it("allows owner, admin, and agency_admin (200) and denies editor (403) without reading tenant_hosts", async () => {
    for (const role of ["owner", "admin", "agency_admin"] as const) {
      const { db, executedSql } = createTrackingMockDb();
      const res = await loadDomainGuidePage({
        rawHandle: "batik-nusantara",
        surface: "app",
        isLocalLoopback: false,
        platformDb: db,
        authUser: { id: `usr-${role}`, name: "User" },
        preResolvedMember: makeMember(role, "active"),
      });

      expect(res.kind).toBe("render");
      if (res.kind === "render") {
        expect(res.httpStatus).toBe(200);
        expect(res.canReadDomains).toBe(true);
        expect(res.cnameTarget).toBe("cname.situsku.click");
      }
      expect(executedSql.some((s) => s.includes("tenant_hosts"))).toBe(false);
      expect(executedSql.some((s) => s.includes("platform_settings"))).toBe(false);
    }

    const { db: editorDb, executedSql: editorSql } = createTrackingMockDb();
    const editorRes = await loadDomainGuidePage({
      rawHandle: "batik-nusantara",
      surface: "app",
      isLocalLoopback: false,
      platformDb: editorDb,
      authUser: { id: "usr-editor", name: "Editor" },
      preResolvedMember: makeMember("editor", "active"),
    });
    expect(editorRes.kind).toBe("render");
    if (editorRes.kind === "render") {
      expect(editorRes.httpStatus).toBe(403);
      expect(editorRes.canReadDomains).toBe(false);
    }
    expect(editorSql.some((s) => s.includes("tenant_hosts"))).toBe(false);
  });

  it("allows trial, grace, and locked owners/admins to read the informational guide", async () => {
    for (const status of ["trial", "grace", "locked"] as const) {
      const { db } = createTrackingMockDb();
      const res = await loadDomainGuidePage({
        rawHandle: "batik-nusantara",
        surface: "app",
        isLocalLoopback: false,
        platformDb: db,
        authUser: { id: "usr-owner", name: "Owner" },
        preResolvedMember: makeMember("owner", status),
      });
      expect(res.kind).toBe("render");
      if (res.kind === "render") {
        expect(res.httpStatus).toBe(200);
        expect(res.canReadDomains).toBe(true);
      }
    }
  });

  it("gates purged (404) and suspended/recovery/purging (302 service-status) STRICTLY BEFORE any tenant DB read", async () => {
    const { db: purgedDb, executedSql: purgedSql } = createTrackingMockDb();
    const purgedRes = await loadDomainGuidePage({
      rawHandle: "batik-nusantara",
      surface: "app",
      isLocalLoopback: false,
      platformDb: purgedDb,
      authUser: { id: "usr-owner", name: "Owner" },
      preResolvedMember: makeMember("owner", "purged"),
    });
    expect(purgedRes).toEqual({ kind: "not_found" });
    expect(purgedSql).toHaveLength(0);

    for (const blockedStatus of ["suspended", "recovery", "purging"] as const) {
      const { db, executedSql } = createTrackingMockDb();
      const res = await loadDomainGuidePage({
        rawHandle: "batik-nusantara",
        surface: "app",
        isLocalLoopback: false,
        platformDb: db,
        authUser: { id: "usr-owner", name: "Owner" },
        preResolvedMember: makeMember("owner", blockedStatus),
      });
      expect(res).toEqual({
        kind: "redirect",
        location: "/dashboard/batik-nusantara/service-status",
      });
      expect(executedSql, `${blockedStatus} must execute ZERO DB queries before redirect`).toHaveLength(0);
    }
  });

  it("returns neutral 404 on non-app surface, invalid handle, or missing authUser", async () => {
    const { db, executedSql } = createTrackingMockDb();
    expect(
      await loadDomainGuidePage({
        rawHandle: "batik-nusantara",
        surface: "public",
        isLocalLoopback: false,
        platformDb: db,
        authUser: { id: "usr-owner", name: "Owner" },
        preResolvedMember: makeMember("owner", "active"),
      }),
    ).toEqual({ kind: "not_found" });

    expect(
      await loadDomainGuidePage({
        rawHandle: "../bad",
        surface: "app",
        isLocalLoopback: false,
        platformDb: db,
        authUser: { id: "usr-owner", name: "Owner" },
      }),
    ).toEqual({ kind: "not_found" });

    expect(
      await loadDomainGuidePage({
        rawHandle: "batik-nusantara",
        surface: "app",
        isLocalLoopback: false,
        platformDb: db,
        authUser: null,
      }),
    ).toEqual({ kind: "not_found" });

    expect(executedSql).toHaveLength(0);
  });
});

describe("TASK-070 unit — static informational, security & base-nova guards", () => {
  it("has ZERO @radix-ui, ZERO asChild, ZERO credential/form inputs, ZERO provider API calls, and private no-store/noindex headers", () => {
    const guideComponentPath = path.join(
      REPO_ROOT,
      "apps/web/src/components/admin/domain-guide/DomainEmailGuide.tsx",
    );
    const guideDataPath = path.join(
      REPO_ROOT,
      "apps/web/src/components/admin/domain-guide/guide-data.ts",
    );
    const guidePagePath = path.join(
      REPO_ROOT,
      "apps/web/src/pages/dashboard/[handle]/settings/domains/guide.astro",
    );

    const componentSrc = fs.readFileSync(guideComponentPath, "utf8");
    const dataSrc = fs.readFileSync(guideDataPath, "utf8");
    const pageSrc = fs.readFileSync(guidePagePath, "utf8");

    for (const [label, src] of [
      ["DomainEmailGuide.tsx", componentSrc],
      ["guide-data.ts", dataSrc],
      ["guide.astro", pageSrc],
    ] as const) {
      expect(src, `${label} must not import @radix-ui`).not.toMatch(/@radix-ui\//);
      expect(src, `${label} must not use asChild`).not.toMatch(/\basChild\b/);
      expect(src, `${label} must not call fetch()`).not.toMatch(/\bfetch\s*\(/);
      expect(src, `${label} must not contain password input`).not.toMatch(/type=["']password["']/i);
      expect(src, `${label} must not contain <input>`).not.toMatch(/<input\b/i);
      expect(src, `${label} must not contain <textarea>`).not.toMatch(/<textarea\b/i);
      expect(src, `${label} must not contain <form>`).not.toMatch(/<form\b/i);
    }

    expect(pageSrc).toContain('"Cache-Control", "private, no-store"');
    expect(pageSrc).toContain('"X-Robots-Tag", "noindex, nofollow"');
    expect(pageSrc).toContain("loadDomainGuidePage");
  });
});

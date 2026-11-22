import fs from "node:fs";
import path from "node:path";
import {
  AuthorizationError,
  CANONICAL_ROLES,
  assertAuthorized,
  canPerform,
  checkSurfaceRouteAccess,
  isRouteGroupAllowedOnSurface,
  type AuthorizationContext,
  type PermissionAction,
} from "@punyasitus/auth/permissions";
import {
  ALL_COMPONENT_SCHEMAS,
  ApiErrorSchema,
  CheckoutAttemptCreateRequestSchema,
  ConsoleAbuseModerationActionRequestSchema,
  ConsoleTenantStateActionRequestSchema,
  CouponApplyRequestSchema,
  DomainConnectRequestSchema,
  FORBIDDEN_TENANT_SELECTOR_KEYS,
  LoginRequestSchema,
  MediaUploadIntentRequestSchema,
  MemberInviteRequestSchema,
  OfferingCreateRequestSchema,
  PageCreateRequestSchema,
  PageUpdateRequestSchema,
  PostCreateRequestSchema,
  PublicAbuseReportRequestSchema,
  PublicEventIngestRequestSchema,
  PublicLeadSubmitRequestSchema,
  ROUTE_CONTRACTS,
  SiteIdentitySettingsPatchSchema,
  TaxonomyCreateRequestSchema,
  buildOpenApiDocument,
  evaluatePublicPostOriginPolicy,
  serializeOpenApiDocument,
} from "@punyasitus/core/schemas";
import { describe, expect, it } from "vitest";
import { SYNTHETIC_TENANTS } from "../fixtures/tenants.ts";

const ROOT = path.resolve(import.meta.dirname, "../..");
const OPENAPI_PATH = path.join(ROOT, "docs/api/openapi.json");

const TENANT_A = SYNTHETIC_TENANTS[0];
const TENANT_B = SYNTHETIC_TENANTS[1];

const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000";
const VALID_ULID = "01JTESTACTOR00000000000001";
const VALID_SHA256 = "a".repeat(64);

function collectSchemaRefs(node: unknown, out: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectSchemaRefs(item, out);
    return;
  }
  if (node !== null && typeof node === "object") {
    const record = node as Record<string, unknown>;
    if (typeof record["$ref"] === "string") {
      out.add(record["$ref"]);
    }
    for (const value of Object.values(record)) {
      collectSchemaRefs(value, out);
    }
  }
}

describe("TASK-024 OpenAPI 3.1 contract generation & drift check", () => {
  it("matches committed docs/api/openapi.json byte-for-byte (CI drift guard)", () => {
    expect(fs.existsSync(OPENAPI_PATH)).toBe(true);
    const committed = fs.readFileSync(OPENAPI_PATH, "utf8");
    const generated = serializeOpenApiDocument();
    expect(committed).toBe(generated);
  });

  it("produces a valid OpenAPI 3.1.1 document covering all PLAN route families, public DTOs, errors, roles, and host-scoped endpoints", () => {
    const doc = buildOpenApiDocument();
    expect(doc.openapi).toBe("3.1.1");
    expect(doc.jsonSchemaDialect).toBe("https://spec.openapis.org/oas/3.1/dialect/base");
    expect(doc["x-punyasitus-roles"]).toEqual([
      "owner",
      "admin",
      "editor",
      "platform_operator",
      "agency_admin",
    ]);
    expect(doc["x-punyasitus-surfaces"]).toEqual(["marketing", "app", "console", "tenant"]);

    // Verify all $ref pointers resolve inside components
    const refs = new Set<string>();
    collectSchemaRefs(doc, refs);
    expect(refs.size).toBeGreaterThan(20);
    for (const ref of refs) {
      if (ref.startsWith("#/components/schemas/")) {
        const name = ref.slice("#/components/schemas/".length);
        expect(doc.components.schemas[name], `Missing component schema ${name}`).toBeDefined();
      } else if (ref.startsWith("#/components/responses/")) {
        const name = ref.slice("#/components/responses/".length);
        expect(doc.components.responses[name], `Missing component response ${name}`).toBeDefined();
      } else if (ref.startsWith("#/components/headers/")) {
        const name = ref.slice("#/components/headers/".length);
        expect(doc.components.headers[name], `Missing component header ${name}`).toBeDefined();
      } else {
        throw new Error(`Unexpected $ref target: ${ref}`);
      }
    }

    // Verify headless-ready Public DTOs exist in components.schemas
    const requiredPublicDtos = [
      "PublicSiteIdentityDto",
      "PublicPageDto",
      "PublicPostDto",
      "PublicOfferingDto",
      "PublicMenuTreeDto",
      "PublicBranchDto",
      "PublicFormDto",
      "PublicTaxonomyDto",
      "PublicSeoMeta",
      "PublicMediaAsset",
      "ApiError",
    ];
    for (const dto of requiredPublicDtos) {
      expect(doc.components.schemas[dto], `Expected component schema ${dto}`).toBeDefined();
    }

    // Verify every PLAN §6 & §13 & §16 route family is documented
    const pathKeys = Object.keys(doc.paths);
    const requiredPaths = [
      "/api/auth/login",
      "/api/account/reauth",
      "/api/account/totp/verify",
      "/api/tenants/{tenantId}/members/invitations",
      "/api/tenants/{tenantId}/members/transfer-owner",
      "/api/tenants/{tenantId}/pages",
      "/api/tenants/{tenantId}/pages/{resourceId}/publish",
      "/api/tenants/{tenantId}/pages/{resourceId}/revisions",
      "/api/tenants/{tenantId}/posts",
      "/api/tenants/{tenantId}/catalog",
      "/api/tenants/{tenantId}/categories",
      "/api/tenants/{tenantId}/tags",
      "/api/tenants/{tenantId}/menus/{location}",
      "/api/tenants/{tenantId}/media/upload-intent",
      "/api/tenants/{tenantId}/outlets",
      "/api/tenants/{tenantId}/settings/{group}",
      "/api/tenants/{tenantId}/settings/publish",
      "/api/tenants/{tenantId}/themes",
      "/api/tenants/{tenantId}/themes/{themeId}/activate",
      "/api/tenants/{tenantId}/preview",
      "/api/tenants/{tenantId}/leads",
      "/api/tenants/{tenantId}/domains",
      "/api/tenants/{tenantId}/domains/{domainId}/make-primary",
      "/api/tenants/{tenantId}/billing",
      "/api/tenants/{tenantId}/billing/attempts",
      "/api/tenants/{tenantId}/billing/receipts",
      "/api/leads",
      "/api/events",
      "/api/abuse-report",
      "/api/console/tenants",
      "/api/console/tenants/{tenantId}/state",
      "/api/console/domains/change",
      "/api/console/jobs/{jobId}/retry",
      "/api/console/moderation/abuse-reports/{reportId}/resolve",
      "/api/console/operators",
      "/api/console/billing/recheck",
    ];
    for (const p of requiredPaths) {
      expect(pathKeys, `Missing OpenAPI path ${p}`).toContain(p);
    }

    // Host-scoped anonymous endpoints explicitly have empty security and tenant-host-only origin policy
    for (const anonPath of ["/api/leads", "/api/events", "/api/abuse-report"]) {
      const op = doc.paths[anonPath]?.["post"] as Record<string, unknown>;
      expect(op).toBeDefined();
      expect(op["security"]).toEqual([]);
      expect(op["x-surface"]).toBe("tenant");
      expect(op["x-origin-policy"]).toBe("tenant-host-only");
    }

    // Operation IDs are unique across all routes
    const opIds = ROUTE_CONTRACTS.map((r) => r.operationId);
    expect(new Set(opIds).size).toBe(opIds.length);
  });

  it("ensures every component schema in the registry produces valid JSON Schema without leftover $schema/$id", () => {
    const doc = buildOpenApiDocument();
    expect(Object.keys(doc.components.schemas).length).toBe(Object.keys(ALL_COMPONENT_SCHEMAS).length);
    for (const [name, schemaObj] of Object.entries(doc.components.schemas)) {
      expect(schemaObj["$schema"], `${name} should not contain $schema`).toBeUndefined();
      expect(schemaObj["$id"], `${name} should not contain $id`).toBeUndefined();
    }
  });
});

describe("TASK-024 strict schema validation & cross-tenant selector rejection", () => {
  const validTenantWriteCases: readonly {
    readonly name: string;
    readonly parse: (payload: unknown) => { readonly success: boolean };
    readonly validPayload: Record<string, unknown>;
  }[] = [
    {
      name: "PageCreateRequest",
      parse: (p) => PageCreateRequestSchema.safeParse(p),
      validPayload: { title: "Tentang Kami", slug: "tentang-kami", sections: [] },
    },
    {
      name: "PageUpdateRequest",
      parse: (p) => PageUpdateRequestSchema.safeParse(p),
      validPayload: { title: "Tentang Kami Baru", version: 2 },
    },
    {
      name: "PostCreateRequest",
      parse: (p) => PostCreateRequestSchema.safeParse(p),
      validPayload: {
        title: "Tips Liburan Bali",
        body: { schemaVersion: 1, blocks: [{ type: "paragraph", text: "Halo dunia" }] },
      },
    },
    {
      name: "OfferingCreateRequest",
      parse: (p) => OfferingCreateRequestSchema.safeParse(p),
      validPayload: {
        offeringType: "tour",
        title: "Paket Tour Bali 3H2M",
        description: { schemaVersion: 1, blocks: [{ type: "paragraph", text: "Itinerary lengkap" }] },
        priceMode: "from",
        price: 1_500_000,
        originalAmount: 1_900_000,
        ctaKind: "whatsapp",
      },
    },
    {
      name: "TaxonomyCreateRequest",
      parse: (p) => TaxonomyCreateRequestSchema.safeParse(p),
      validPayload: { kind: "post_category", name: "Promo" },
    },
    {
      name: "SiteIdentitySettingsPatch",
      parse: (p) => SiteIdentitySettingsPatchSchema.safeParse(p),
      validPayload: { siteName: "Alpha Studio", version: 1 },
    },
    {
      name: "MediaUploadIntentRequest",
      parse: (p) => MediaUploadIntentRequestSchema.safeParse(p),
      validPayload: {
        kind: "image",
        filename: "hero-banner.jpg",
        mimeType: "image/jpeg",
        declaredBytes: 512_000,
        sha256: VALID_SHA256,
        alt: "Banner utama studio",
      },
    },
    {
      name: "MemberInviteRequest",
      parse: (p) => MemberInviteRequestSchema.safeParse(p),
      validPayload: { email: "editor@example.com", role: "editor" },
    },
    {
      name: "DomainConnectRequest",
      parse: (p) => DomainConnectRequestSchema.safeParse(p),
      validPayload: { hostname: "www.tokocontoh.id", mode: "zero_downtime_migration" },
    },
    {
      name: "CheckoutAttemptCreateRequest",
      parse: (p) => CheckoutAttemptCreateRequestSchema.safeParse(p),
      validPayload: {
        plan: "monthly",
        channelKind: "QRIS",
        channelCode: "QRIS_STATIC",
        idempotencyKey: VALID_UUID,
      },
    },
    {
      name: "CouponApplyRequest",
      parse: (p) => CouponApplyRequestSchema.safeParse(p),
      validPayload: { couponCode: "HEMAT20", plan: "yearly" },
    },
    {
      name: "PublicLeadSubmitRequest",
      parse: (p) => PublicLeadSubmitRequestSchema.safeParse(p),
      validPayload: {
        name: "Budi Santoso",
        phone: "6281234567890",
        email: "budi@example.com",
        message: "Mau tanya paket wisata Bali.",
        preferred_date: "2026-12-01",
        preferred_time: "pagi",
        branch: 1,
      },
    },
    {
      name: "PublicEventIngestRequest",
      parse: (p) => PublicEventIngestRequestSchema.safeParse(p),
      validPayload: {
        eventId: VALID_UUID,
        eventName: "wa_click",
        path: "/tour/paket-bali",
        targetKind: "tour",
        targetSlug: "paket-bali",
      },
    },
    {
      name: "PublicAbuseReportRequest",
      parse: (p) => PublicAbuseReportRequestSchema.safeParse(p),
      validPayload: {
        category: "phishing",
        reportedPath: "/login-palsu",
        description: "Halaman ini meniru form login bank untuk mencuri kredensial.",
        turnstileToken: "cf-turnstile-token-ok",
      },
    },
  ];

  it("accepts valid payloads and rejects unknown fields across all input schemas (.strict())", () => {
    for (const tc of validTenantWriteCases) {
      expect(tc.parse(tc.validPayload).success, `${tc.name} should accept valid payload`).toBe(true);
      expect(
        tc.parse({ ...tc.validPayload, unexpectedExtraField: "injected" }).success,
        `${tc.name} must reject unknown fields`,
      ).toBe(false);
    }

    // Also verify auth & console schemas reject unknown fields
    expect(
      LoginRequestSchema.safeParse({
        email: "owner@example.com",
        password: "correct-password-123",
        turnstileToken: "token",
        extra: true,
      }).success,
    ).toBe(false);

    expect(
      ConsoleTenantStateActionRequestSchema.safeParse({
        action: "suspend_hold",
        reason: "Confirmed phishing abuse report #123",
        expectedVersion: 1,
        idempotencyKey: VALID_UUID,
        forceBypassAudit: true,
      }).success,
    ).toBe(false);

    expect(
      ConsoleAbuseModerationActionRequestSchema.safeParse({
        status: "actioned",
        applyOperatorHold: true,
        reason: "Verified impersonation page",
        expectedVersion: 1,
        idempotencyKey: VALID_UUID,
        extraField: 1,
      }).success,
    ).toBe(false);
  });

  it("rejects cross-tenant selector injection (tenantId, organizationId, etc.) in all tenant-scoped and host-scoped write payloads", () => {
    for (const tc of validTenantWriteCases) {
      for (const selectorKey of FORBIDDEN_TENANT_SELECTOR_KEYS) {
        const poisoned = { ...tc.validPayload, [selectorKey]: TENANT_B.id };
        expect(
          tc.parse(poisoned).success,
          `${tc.name} must reject injected cross-tenant selector "${selectorKey}"`,
        ).toBe(false);
      }
    }
  });

  it("enforces domain-specific invariants (no PII in events, no SVG/oversized images, no COD billing, valid pricing, valid error envelope)", () => {
    // Events strictly reject PII fields and query strings/emails/phones in path
    expect(
      PublicEventIngestRequestSchema.safeParse({
        eventId: VALID_UUID,
        eventName: "wa_click",
        path: "/tour/bali",
        email: "visitor@example.com",
      }).success,
    ).toBe(false);
    expect(
      PublicEventIngestRequestSchema.safeParse({
        eventId: VALID_UUID,
        eventName: "page_view",
        path: "/contact?email=visitor@example.com",
      }).success,
    ).toBe(false);
    expect(
      PublicEventIngestRequestSchema.safeParse({
        eventId: VALID_UUID,
        eventName: "page_view",
        path: "/hubungi-6281234567890",
      }).success,
    ).toBe(false);

    // Media upload rejects SVG and images > 5 MB
    expect(
      MediaUploadIntentRequestSchema.safeParse({
        kind: "image",
        filename: "logo.svg",
        mimeType: "image/svg+xml",
        declaredBytes: 1024,
        sha256: VALID_SHA256,
        alt: "Logo",
      }).success,
    ).toBe(false);
    expect(
      MediaUploadIntentRequestSchema.safeParse({
        kind: "image",
        filename: "huge.jpg",
        mimeType: "image/jpeg",
        declaredBytes: 5_000_001,
        sha256: VALID_SHA256,
        alt: "Huge",
      }).success,
    ).toBe(false);

    // Billing rejects COD channel and client-supplied prices
    expect(
      CheckoutAttemptCreateRequestSchema.safeParse({
        plan: "monthly",
        channelKind: "COD",
        channelCode: "COD",
        idempotencyKey: VALID_UUID,
      }).success,
    ).toBe(false);
    expect(
      CheckoutAttemptCreateRequestSchema.safeParse({
        plan: "monthly",
        channelKind: "QRIS",
        channelCode: "QRIS",
        idempotencyKey: VALID_UUID,
        amountIdr: 1,
      }).success,
    ).toBe(false);

    // Domain connect rejects platform/SaaS zone hostnames and > 64 char hostnames
    expect(
      DomainConnectRequestSchema.safeParse({
        hostname: "evil.situsku.click",
        mode: "new_domain",
      }).success,
    ).toBe(false);
    expect(
      DomainConnectRequestSchema.safeParse({
        hostname: `${"a".repeat(60)}.example.com`,
        mode: "new_domain",
      }).success,
    ).toBe(false);

    // Offering pricing rejects fabricated price on on_request and invalid originalAmount <= price
    expect(
      OfferingCreateRequestSchema.safeParse({
        offeringType: "service",
        title: "Jasa Audit",
        description: { schemaVersion: 1, blocks: [] },
        priceMode: "on_request",
        price: 0,
        ctaKind: "inquiry",
      }).success,
    ).toBe(false);
    expect(
      OfferingCreateRequestSchema.safeParse({
        offeringType: "product",
        title: "Kopi Arabika",
        description: { schemaVersion: 1, blocks: [] },
        priceMode: "fixed",
        price: 100_000,
        originalAmount: 90_000,
        ctaKind: "whatsapp",
      }).success,
    ).toBe(false);

    // Standard ApiError envelope validates cleanly and rejects stack traces
    expect(
      ApiErrorSchema.safeParse({
        error: {
          code: "VALIDATION_ERROR",
          message: "Input tidak valid",
          fields: [{ field: "phone", code: "invalid_string", message: "Format nomor tidak valid" }],
        },
        requestId: "req_01JTEST",
      }).success,
    ).toBe(true);
    expect(
      ApiErrorSchema.safeParse({
        error: { code: "BAD_REQUEST", message: "Bad", stack: "Error at line 1" },
        requestId: "req_01JTEST",
      }).success,
    ).toBe(false);
  });

  it("enforces PLAN §6 host-scoped public POST origin policy", () => {
    const tenantOrigin = `https://${TENANT_A.subdomainHost}`;
    expect(
      evaluatePublicPostOriginPolicy({
        origin: tenantOrigin,
        secFetchSite: "same-origin",
        contentType: "application/json",
        resolvedTenantOrigin: tenantOrigin,
      }),
    ).toEqual({ allowed: true });

    // Cross-origin rejected
    expect(
      evaluatePublicPostOriginPolicy({
        origin: `https://${TENANT_B.subdomainHost}`,
        secFetchSite: "cross-site",
        contentType: "application/json",
        resolvedTenantOrigin: tenantOrigin,
      }).allowed,
    ).toBe(false);

    // Literal "null" Origin rejected
    expect(
      evaluatePublicPostOriginPolicy({
        origin: "null",
        secFetchSite: "cross-site",
        contentType: "application/x-www-form-urlencoded",
        resolvedTenantOrigin: tenantOrigin,
      }).allowed,
    ).toBe(false);

    // Missing Origin allowed for no-JS form POST when Sec-Fetch-Site is absent or same-origin
    expect(
      evaluatePublicPostOriginPolicy({
        origin: null,
        secFetchSite: "same-origin",
        contentType: "application/x-www-form-urlencoded",
        resolvedTenantOrigin: tenantOrigin,
      }).allowed,
    ).toBe(true);

    // Missing Origin rejected for JSON POST or cross-site form POST
    expect(
      evaluatePublicPostOriginPolicy({
        origin: null,
        secFetchSite: "same-origin",
        contentType: "application/json",
        resolvedTenantOrigin: tenantOrigin,
      }).allowed,
    ).toBe(false);
    expect(
      evaluatePublicPostOriginPolicy({
        origin: null,
        secFetchSite: "cross-site",
        contentType: "application/x-www-form-urlencoded",
        resolvedTenantOrigin: tenantOrigin,
      }).allowed,
    ).toBe(false);
  });
});

describe("TASK-024 RBAC matrix, cross-tenant denial, and surface routing matrix", () => {
  it("enforces canonical role allow/deny boundaries matching PLAN §4", () => {
    expect(CANONICAL_ROLES).toEqual([
      "owner",
      "admin",
      "editor",
      "platform_operator",
      "agency_admin",
    ]);

    // Editor: content/media/taxonomy/menu only; NO settings, leads, domains, members, billing, console
    expect(canPerform("editor", "content:write")).toBe(true);
    expect(canPerform("editor", "content:publish")).toBe(true);
    expect(canPerform("editor", "media:upload")).toBe(true);
    expect(canPerform("editor", "settings:write")).toBe(false);
    expect(canPerform("editor", "theme:activate")).toBe(false);
    expect(canPerform("editor", "lead:read")).toBe(false);
    expect(canPerform("editor", "domain:connect")).toBe(false);
    expect(canPerform("editor", "member:invite")).toBe(false);
    expect(canPerform("editor", "billing:pay")).toBe(false);
    expect(canPerform("editor", "console:tenants:read")).toBe(false);

    // Admin: adds settings, themes, outlets, analytics, leads; NO domain mutations, member invites, owner transfer, billing, console
    expect(canPerform("admin", "settings:write")).toBe(true);
    expect(canPerform("admin", "theme:activate")).toBe(true);
    expect(canPerform("admin", "lead:read")).toBe(true);
    expect(canPerform("admin", "lead:update")).toBe(true);
    expect(canPerform("admin", "domain:connect")).toBe(false);
    expect(canPerform("admin", "member:invite")).toBe(false);
    expect(canPerform("admin", "tenant:transfer_owner")).toBe(false);
    expect(canPerform("admin", "billing:pay")).toBe(false);
    expect(canPerform("admin", "console:tenants:read")).toBe(false);

    // Owner: full tenant management + billing + owner transfer; NO active locked domain removal & NO console
    expect(canPerform("owner", "domain:connect")).toBe(true);
    expect(canPerform("owner", "domain:remove_inactive")).toBe(true);
    expect(canPerform("owner", "domain:remove_active")).toBe(false);
    expect(canPerform("owner", "member:invite")).toBe(true);
    expect(canPerform("owner", "tenant:transfer_owner")).toBe(true);
    expect(canPerform("owner", "billing:pay")).toBe(true);
    expect(canPerform("owner", "console:tenants:read")).toBe(false);

    // Agency admin: manages client tenants + billing + agency portal; NO owner transfer & NO console
    expect(canPerform("agency_admin", "agency:portal:access")).toBe(true);
    expect(canPerform("agency_admin", "billing:pay")).toBe(true);
    expect(canPerform("agency_admin", "domain:connect")).toBe(true);
    expect(canPerform("agency_admin", "tenant:transfer_owner")).toBe(false);
    expect(canPerform("agency_admin", "console:tenants:read")).toBe(false);

    // Platform operator: console + active locked domain removal; separate from organization roles
    expect(canPerform("platform_operator", "console:tenants:provision")).toBe(true);
    expect(canPerform("platform_operator", "domain:remove_active")).toBe(true);
    expect(canPerform("platform_operator", "content:write")).toBe(false);
    expect(canPerform("platform_operator", "lead:read")).toBe(false);
  });

  function expectAuthError(
    fn: () => void,
    expectedStatus: 401 | 403 | 404,
    expectedCode: string,
  ): void {
    try {
      fn();
      throw new Error(`Expected AuthorizationError(${expectedStatus}, ${expectedCode}) but succeeded`);
    } catch (err) {
      expect(err).toBeInstanceOf(AuthorizationError);
      const authErr = err as AuthorizationError;
      expect(authErr.status).toBe(expectedStatus);
      expect(authErr.code).toBe(expectedCode);
    }
  }

  it("proves tenant ID/handle is a selector only, denying cross-tenant access with 404 and same-tenant role denial with 403", () => {
    const ownerOfTenantA: AuthorizationContext = {
      actorId: VALID_ULID,
      surface: "app",
      role: "owner",
      tenantId: TENANT_A.id,
      tenantStatus: "active",
    };

    // Same-tenant allowed
    expect(() => assertAuthorized(ownerOfTenantA, "content:publish", TENANT_A.id)).not.toThrow();

    // Cross-tenant access to Tenant B returns 404 (never reveals Tenant B exists)
    expectAuthError(
      () => assertAuthorized(ownerOfTenantA, "content:read", TENANT_B.id),
      404,
      "NOT_FOUND",
    );
    expectAuthError(
      () => assertAuthorized(ownerOfTenantA, "content:write", TENANT_B.id),
      404,
      "NOT_FOUND",
    );

    // Same-tenant role denial returns 403
    const editorOfTenantA: AuthorizationContext = {
      actorId: VALID_ULID,
      surface: "app",
      role: "editor",
      tenantId: TENANT_A.id,
      tenantStatus: "active",
    };
    expect(() => assertAuthorized(editorOfTenantA, "content:write", TENANT_A.id)).not.toThrow();
    expectAuthError(
      () => assertAuthorized(editorOfTenantA, "lead:read", TENANT_A.id),
      403,
      "FORBIDDEN",
    );

    // Unauthenticated returns 401
    expectAuthError(
      () =>
        assertAuthorized(
          { actorId: null, surface: "app", role: "owner", tenantId: TENANT_A.id },
          "content:read",
          TENANT_A.id,
        ),
      401,
      "UNAUTHENTICATED",
    );

    // Owner transfer requires recent reauthentication
    expectAuthError(
      () => assertAuthorized(ownerOfTenantA, "tenant:transfer_owner", TENANT_A.id),
      403,
      "REAUTH_REQUIRED",
    );
    expect(() =>
      assertAuthorized(
        { ...ownerOfTenantA, reauthenticated: true },
        "tenant:transfer_owner",
        TENANT_A.id,
      ),
    ).not.toThrow();
  });

  it("enforces mandatory TOTP, operator grant, audited tenant context, and service lifecycle overrides (trial/locked/suspended)", () => {
    // Agency admin requires TOTP + membership
    const agencyNoTotp: AuthorizationContext = {
      actorId: VALID_ULID,
      surface: "app",
      role: "agency_admin",
      memberTenantIds: new Set([TENANT_A.id]),
      totpVerified: false,
    };
    expectAuthError(
      () => assertAuthorized(agencyNoTotp, "billing:pay", TENANT_A.id),
      403,
      "TOTP_REQUIRED",
    );
    expect(() =>
      assertAuthorized({ ...agencyNoTotp, totpVerified: true }, "billing:pay", TENANT_A.id),
    ).not.toThrow();
    expectAuthError(
      () => assertAuthorized({ ...agencyNoTotp, totpVerified: true }, "billing:pay", TENANT_B.id),
      404,
      "NOT_FOUND",
    );

    // Console action denied on app surface (404), denied without grant (403), denied without TOTP/reauth (403)
    const operatorCtx: AuthorizationContext = {
      actorId: VALID_ULID,
      surface: "console",
      role: "platform_operator",
      platformGrantActive: true,
      totpVerified: true,
      reauthenticated: false,
    };
    expect(() => assertAuthorized(operatorCtx, "console:tenants:read")).not.toThrow();
    expectAuthError(
      () => assertAuthorized(operatorCtx, "console:tenants:state"),
      403,
      "REAUTH_REQUIRED",
    );
    expect(() =>
      assertAuthorized({ ...operatorCtx, reauthenticated: true }, "console:tenants:state"),
    ).not.toThrow();
    expectAuthError(
      () => assertAuthorized({ ...operatorCtx, surface: "app" }, "console:tenants:read"),
      404,
      "NOT_FOUND",
    );
    expectAuthError(
      () => assertAuthorized({ ...operatorCtx, platformGrantActive: false }, "console:tenants:read"),
      403,
      "FORBIDDEN",
    );

    // Operator accessing tenant context requires explicit matching auditedTenantContext
    const operatorOnApp: AuthorizationContext = {
      actorId: VALID_ULID,
      surface: "app",
      role: "platform_operator",
      platformGrantActive: true,
      totpVerified: true,
    };
    expectAuthError(
      () => assertAuthorized(operatorOnApp, "content:read", TENANT_A.id),
      404,
      "NOT_FOUND",
    );
    expect(() =>
      assertAuthorized(
        {
          ...operatorOnApp,
          auditedTenantContext: {
            tenantId: TENANT_A.id,
            reason: "Authorized owner support ticket #8841",
            auditId: VALID_ULID,
          },
        },
        "content:read",
        TENANT_A.id,
      ),
    ).not.toThrow();

    // Service lifecycle overrides (PLAN §17.1)
    const trialOwner: AuthorizationContext = {
      actorId: VALID_ULID,
      surface: "app",
      role: "owner",
      tenantId: TENANT_A.id,
      tenantStatus: "trial",
    };
    expectAuthError(
      () => assertAuthorized(trialOwner, "domain:connect", TENANT_A.id),
      403,
      "TRIAL_DOMAIN_FORBIDDEN",
    );

    const lockedOwner: AuthorizationContext = { ...trialOwner, tenantStatus: "locked" };
    expect(() => assertAuthorized(lockedOwner, "content:read", TENANT_A.id)).not.toThrow();
    expect(() => assertAuthorized(lockedOwner, "billing:pay", TENANT_A.id)).not.toThrow();
    expect(() => assertAuthorized(lockedOwner, "lead:export_csv", TENANT_A.id)).not.toThrow();
    expectAuthError(
      () => assertAuthorized(lockedOwner, "content:write", TENANT_A.id),
      403,
      "SUBSCRIPTION_LOCKED",
    );

    const suspendedOwner: AuthorizationContext = { ...trialOwner, tenantStatus: "suspended" };
    expect(() => assertAuthorized(suspendedOwner, "billing:pay", TENANT_A.id)).not.toThrow();
    expect(() => assertAuthorized(suspendedOwner, "lead:export_csv", TENANT_A.id)).not.toThrow();
    expectAuthError(
      () => assertAuthorized(suspendedOwner, "content:read", TENANT_A.id),
      403,
      "SUBSCRIPTION_LOCKED",
    );
  });

  it("enforces the 4-surface route access matrix (marketing, app, console, tenant)", () => {
    expect(isRouteGroupAllowedOnSurface("marketing", "marketing_public")).toBe(true);
    expect(isRouteGroupAllowedOnSurface("marketing", "app_dashboard")).toBe(false);
    expect(isRouteGroupAllowedOnSurface("app", "console_api")).toBe(false);
    expect(isRouteGroupAllowedOnSurface("console", "console_api")).toBe(true);
    expect(isRouteGroupAllowedOnSurface("tenant", "tenant_anonymous_post_api")).toBe(true);
    expect(isRouteGroupAllowedOnSurface("tenant", "app_tenant_api")).toBe(false);

    // Tenant host allows public pages, DCV, and the 3 anonymous POST endpoints; returns 404 on admin/console/auth
    expect(checkSurfaceRouteAccess("tenant", "/").allowed).toBe(true);
    expect(checkSurfaceRouteAccess("tenant", "/blog/tips-bali").allowed).toBe(true);
    expect(checkSurfaceRouteAccess("tenant", "/.well-known/acme-challenge/tok").allowed).toBe(true);
    expect(checkSurfaceRouteAccess("tenant", "/api/leads").allowed).toBe(true);
    expect(checkSurfaceRouteAccess("tenant", "/api/events").allowed).toBe(true);
    expect(checkSurfaceRouteAccess("tenant", "/api/abuse-report").allowed).toBe(true);
    for (const forbidden of [
      "/dashboard/alpha-studio",
      "/agency",
      "/affiliate",
      "/console",
      "/auth/login",
      "/account",
      "/mcp",
      "/oauth2/token",
      "/api/console/tenants",
      "/api/tenants/alpha-studio/pages",
      "/api/auth/login",
    ]) {
      const res = checkSurfaceRouteAccess("tenant", forbidden);
      expect(res.allowed, `Tenant host must deny ${forbidden}`).toBe(false);
      expect(res.status).toBe(404);
    }

    // Console host exposes /api/console/* and denies tenant/app routes
    expect(checkSurfaceRouteAccess("console", "/api/console/tenants").allowed).toBe(true);
    expect(checkSurfaceRouteAccess("console", "/dashboard/alpha-studio").status).toBe(404);
    expect(checkSurfaceRouteAccess("console", "/api/leads").status).toBe(404);

    // App host exposes /dashboard/* and /api/tenants/* and denies console & tenant anonymous POSTs
    expect(checkSurfaceRouteAccess("app", "/dashboard/alpha-studio").allowed).toBe(true);
    expect(checkSurfaceRouteAccess("app", "/api/tenants/alpha-studio/pages").allowed).toBe(true);
    expect(checkSurfaceRouteAccess("app", "/api/console/tenants").status).toBe(404);
    expect(checkSurfaceRouteAccess("app", "/api/leads").status).toBe(404);

    // Marketing host exposes marketing routes only
    expect(checkSurfaceRouteAccess("marketing", "/pricing").allowed).toBe(true);
    expect(checkSurfaceRouteAccess("marketing", "/dashboard").status).toBe(404);
    expect(checkSurfaceRouteAccess("marketing", "/api/console/tenants").status).toBe(404);

    // Sanity check every route contract's requiredPermission (if set) is recognized by the RBAC matrix
    for (const route of ROUTE_CONTRACTS) {
      if (route.requiredPermission) {
        const perm = route.requiredPermission as PermissionAction;
        const anyRoleCanPerform = CANONICAL_ROLES.some((r) => canPerform(r, perm));
        expect(anyRoleCanPerform, `Unknown permission action on ${route.operationId}: ${perm}`).toBe(
          true,
        );
      }
    }
  });
});

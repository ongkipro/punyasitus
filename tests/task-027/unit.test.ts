import {
  buildPublishedSnapshot,
  extractDraftSnapshotForAdmin,
  extractPublishedSnapshot,
  PublicationValidationError,
  sanitizeNavigationHref,
  sanitizePublishedHtmlFragment,
  StaleRevisionError,
  validateResourceDraft,
  validateResourceForPublish,
} from "@punyasitus/core/content/index";
import {
  computeContrastRatio,
  ensureAccessibleBrandColor,
  hasDangerousCssSyntax,
  parseAndValidateThemeJson,
  renderThemeCssCustomProperties,
  sanitizeThemeColor,
  ThemeValidationError,
  validateThemeConfigSnapshot,
  validateThemeTokens,
} from "@punyasitus/core/theme/index";
import { describe, expect, it, vi } from "vitest";
import {
  buildRevisionedCacheKey,
  evaluateCacheBypass,
  isPreviewRequest,
  MAX_EDGE_CACHE_TTL_SECONDS,
  normalizeSafeQueryParams,
  PREVIEW_CACHE_CONTROL,
  PREVIEW_ROBOTS_TAG,
  serveWithRevisionedEdgeCache,
  TENANT_CONSENT_COOKIE_NAME,
} from "../../apps/web/src/core/cache.ts";

function createMemoryCache(): Cache & {
  readonly store: Map<string, Response>;
  readonly matchSpy: ReturnType<typeof vi.fn>;
  readonly putSpy: ReturnType<typeof vi.fn>;
} {
  const store = new Map<string, Response>();
  const matchSpy = vi.fn(async (req: RequestInfo | URL) => {
    const key = typeof req === "string" ? req : req instanceof URL ? req.href : req.url;
    const hit = store.get(key);
    return hit ? hit.clone() : undefined;
  });
  const putSpy = vi.fn(async (req: RequestInfo | URL, res: Response) => {
    const key = typeof req === "string" ? req : req instanceof URL ? req.href : req.url;
    store.set(key, res.clone());
  });
  return {
    store,
    matchSpy,
    putSpy,
    match: matchSpy as unknown as Cache["match"],
    put: putSpy as unknown as Cache["put"],
    delete: vi.fn(async () => false) as unknown as Cache["delete"],
    add: vi.fn(async () => undefined) as unknown as Cache["add"],
    addAll: vi.fn(async () => undefined) as unknown as Cache["addAll"],
    keys: vi.fn(async () => []) as unknown as Cache["keys"],
    matchAll: vi.fn(async () => []) as unknown as Cache["matchAll"],
  };
}

describe("TASK-027 Unit — Theme Token Validation & CSS Injection Defense", () => {
  it("accepts valid theme tokens/variants and emits safe CSS custom properties", () => {
    const snapshot = validateThemeConfigSnapshot({
      themeId: "compro",
      tokens: {
        primaryColor: "#0AF",
        secondaryColor: "#1E40AF",
        fontFamily: "plus-jakarta-sans",
        headingFontFamily: "system",
        borderRadiusPx: 12,
        spacingScale: 1.1,
        containerMaxWidthPx: 1280,
      },
      variants: {
        styleVariant: "editorial-clean",
        headerVariant: "sticky-cta",
        footerVariant: "columns",
        heroVariant: "split",
        buttonStyle: "solid",
      },
    });

    expect(snapshot.tokens.primaryColor).toBe("#00aaff");
    expect(snapshot.tokens.secondaryColor).toBe("#1e40af");

    const css = renderThemeCssCustomProperties(snapshot);
    expect(css).toContain(":root {");
    expect(css).toContain("--ps-color-primary:");
    expect(css).toContain("--ps-font-body: \"Plus Jakarta Sans\"");
    expect(css).toContain("--ps-radius-base: 12px");
    expect(css).not.toMatch(/url\(|expression\(|<script/i);
  });

  it("rejects CSS injection vectors across colors, fonts, variants, and bounds", () => {
    const hostileValues = [
      "#fff; background: url(https://evil.example/x.png)",
      "expression(alert(1))",
      "#112233} body { display: none",
      "<style>body{}</style>",
      "#112233</style><script>alert(1)</script>",
      "url(javascript:alert(1))",
      "@import url(evil.css)",
      "#112233/*comment*/",
      "#112233\ncolor:red",
    ];

    for (const payload of hostileValues) {
      expect(hasDangerousCssSyntax(payload)).toBe(true);
      expect(() => sanitizeThemeColor(payload)).toThrow(ThemeValidationError);
      expect(() =>
        validateThemeTokens({ primaryColor: payload, secondaryColor: "#112233" }),
      ).toThrow(ThemeValidationError);
    }

    // Disallowed arbitrary font family
    expect(() =>
      validateThemeTokens({
        primaryColor: "#112233",
        secondaryColor: "#334455",
        fontFamily: "Comic Sans; url(evil)",
      }),
    ).toThrow(ThemeValidationError);

    // REQ-020: at most 1 non-system custom font
    expect(() =>
      validateThemeTokens({
        primaryColor: "#112233",
        secondaryColor: "#334455",
        fontFamily: "inter",
        headingFontFamily: "lora",
      }),
    ).toThrow(ThemeValidationError);

    // Out-of-bounds radius / spacing
    expect(() =>
      validateThemeTokens({
        primaryColor: "#112233",
        secondaryColor: "#334455",
        borderRadiusPx: 99,
      }),
    ).toThrow(ThemeValidationError);
    expect(() =>
      validateThemeTokens({
        primaryColor: "#112233",
        secondaryColor: "#334455",
        spacingScale: 3.5,
      }),
    ).toThrow(ThemeValidationError);

    // Malformed JSON rejected cleanly
    expect(() => parseAndValidateThemeJson("compro", "{bad json", "{}")).toThrow(
      ThemeValidationError,
    );
  });

  it("adjusts low-contrast brand colors to >= 4.5:1 and discloses the adjustment (REQ-020)", () => {
    const lowContrast = ensureAccessibleBrandColor("#ffff00", "#ffffff", 4.5);
    expect(lowContrast.adjusted).toBe(true);
    expect(lowContrast.originalColor).toBe("#ffff00");
    expect(computeContrastRatio(lowContrast.color, "#ffffff")).toBeGreaterThanOrEqual(4.5);

    const highContrast = ensureAccessibleBrandColor("#1e3a8a", "#ffffff", 4.5);
    expect(highContrast.adjusted).toBe(false);
    expect(highContrast.color).toBe("#1e3a8a");
  });
});

describe("TASK-027 Unit — Draft/Published Snapshot Separation & Sanitization", () => {
  it("extractPublishedSnapshot returns null for draft/trashed/deleted/uninitialized records and NEVER falls back to draftJson", () => {
    const draftPayload = JSON.stringify({
      snapshotVersion: 1,
      resourceType: "page",
      data: {
        slug: "rahasia",
        title: "Secret Draft Title",
        isHomepage: false,
        layoutMode: "standard",
        sections: [],
      },
      _draftMetadata: { draftNotes: "Internal secret note" },
    });

    // Unpublished draft (even if publishedJson somehow existed)
    expect(
      extractPublishedSnapshot("page", {
        resourceId: 1,
        status: "draft",
        draftJson: draftPayload,
        publishedJson: draftPayload,
        version: 2,
      }),
    ).toBeNull();

    // Trashed or soft-deleted
    expect(
      extractPublishedSnapshot("page", {
        resourceId: 1,
        status: "published",
        deletedAt: Date.now(),
        draftJson: draftPayload,
        publishedJson: draftPayload,
        version: 2,
      }),
    ).toBeNull();

    // Published status without publishedJson NEVER falls back to draftJson
    expect(
      extractPublishedSnapshot("page", {
        resourceId: 1,
        status: "published",
        draftJson: draftPayload,
        publishedJson: null,
        version: 2,
      }),
    ).toBeNull();

    // Config resource without publishedJson returns null
    expect(
      extractPublishedSnapshot("site_settings", {
        resourceId: 1,
        draftJson: JSON.stringify({ siteTitle: "Draft Only" }),
        publishedJson: null,
        version: 1,
      }),
    ).toBeNull();
  });

  it("strips draft-only fields from published snapshots while keeping them in admin draft DTOs", () => {
    const publishedEnvelope = buildPublishedSnapshot(
      "page",
      {
        slug: "tentang-kami",
        title: "Tentang Kami",
        isHomepage: false,
        layoutMode: "focused",
        sections: [
          {
            id: "sec-1",
            kind: "hero",
            heading: "Halo",
            subheading: "Sub",
            bodyHtml: '<p onclick="alert(1)" style="color:red">Aman</p><script>evil()</script>',
            ctaLabel: "Hubungi",
            ctaHref: "/kontak",
          },
        ],
        draftNotes: "Do not publish this internal remark",
        internalNotes: "Private owner memo",
        reviewComments: ["Needs legal review"],
      },
      { publishedAt: 1_700_000_000_000, contentModifiedAt: 1_700_000_000_000 },
    );

    const serialized = JSON.stringify(publishedEnvelope);
    expect(serialized).not.toContain("draftNotes");
    expect(serialized).not.toContain("internalNotes");
    expect(serialized).not.toContain("reviewComments");
    expect(serialized).not.toContain("<script");
    expect(serialized).not.toContain("onclick=");
    expect(serialized).not.toContain("style=");

    const dto = extractPublishedSnapshot("page", {
      resourceId: 7,
      status: "published",
      draftJson: JSON.stringify({
        snapshotVersion: 1,
        resourceType: "page",
        data: {
          slug: "tentang-kami",
          title: "Unpublished Draft Edit",
          isHomepage: false,
          layoutMode: "standard",
          sections: [],
        },
        _draftMetadata: { draftNotes: "Still editing" },
      }),
      publishedJson: serialized,
      publishedAt: 1_700_000_000_000,
      contentModifiedAt: 1_700_000_000_000,
      version: 4,
    });

    expect(dto).not.toBeNull();
    expect(dto?.data.title).toBe("Tentang Kami");
    expect(dto?.data.layoutMode).toBe("focused");
    expect(dto?.data.sections[0]?.bodyHtml).toBe("<p>Aman</p>");

    const adminDto = extractDraftSnapshotForAdmin("page", {
      resourceId: 7,
      status: "published",
      draftJson: JSON.stringify({
        snapshotVersion: 1,
        resourceType: "page",
        data: {
          slug: "tentang-kami",
          title: "Unpublished Draft Edit",
          isHomepage: false,
          layoutMode: "standard",
          sections: [],
        },
        _draftMetadata: { draftNotes: "Still editing" },
      }),
      publishedJson: serialized,
      publishedAt: 1_700_000_000_000,
      contentModifiedAt: 1_700_000_000_000,
      version: 4,
      updatedAt: 1_700_000_005_000,
    });

    expect(adminDto?.draft?.title).toBe("Unpublished Draft Edit");
    expect(adminDto?.published?.title).toBe("Tentang Kami");
    expect(adminDto?.hasUnpublishedChanges).toBe(true);
    expect(adminDto?.draftMetadata).toEqual({ draftNotes: "Still editing" });
  });

  it("enforces forbidden tenant selector rejection, safe URLs, offering pricing, and error HTTP statuses", () => {
    // Forbidden tenantId selector in payload -> 422
    expect(() =>
      validateResourceDraft("page", {
        tenantId: "01JFORGED00000000000000001",
        slug: "beranda",
        title: "Beranda",
        isHomepage: true,
        sections: [],
      }),
    ).toThrow(PublicationValidationError);

    // Unsafe URLs rejected
    expect(() => sanitizeNavigationHref("javascript:alert(1)")).toThrow(PublicationValidationError);
    expect(() => sanitizeNavigationHref("data:text/html,<script>alert(1)</script>")).toThrow(
      PublicationValidationError,
    );
    expect(() => sanitizeNavigationHref("//evil.example/phish")).toThrow(
      PublicationValidationError,
    );
    expect(() => sanitizeNavigationHref("https://127.0.0.1/internal")).toThrow(
      PublicationValidationError,
    );
    expect(sanitizeNavigationHref("/layanan")).toBe("/layanan");
    expect(sanitizeNavigationHref("https://shopee.co.id/toko")).toBe("https://shopee.co.id/toko");

    // HTML fragment sanitizer strips dangerous constructs
    const sanitized = sanitizePublishedHtmlFragment(
      '<p>Hello</p><iframe src="https://evil.test"></iframe><a href="javascript:alert(1)" onerror="bad()">link</a>',
    );
    expect(sanitized).not.toContain("<iframe");
    expect(sanitized).not.toContain("javascript:");
    expect(sanitized).not.toContain("onerror=");

    // Offering pricing invariants & business_profile deprecated category check
    expect(() =>
      validateResourceForPublish("offering", {
        offeringType: "product",
        slug: "kopi",
        title: "Kopi",
        priceMode: "on_request",
        price: 50_000,
        ctaMode: "whatsapp",
      }),
    ).toThrow(PublicationValidationError);

    expect(() =>
      validateResourceForPublish("business_profile", {
        businessName: "Kantor Hukum",
        businessCategory: "ProfessionalService",
      }),
    ).toThrow(PublicationValidationError);

    // Error status codes
    const stale = new StaleRevisionError({
      resourceType: "page",
      resourceId: 1,
      expectedVersion: 2,
      actualVersion: 3,
    });
    expect(stale.httpStatus).toBe(409);
    expect(stale.code).toBe("STALE_VERSION");
    expect(stale.actualVersion).toBe(3);

    const validationErr = new PublicationValidationError("bad");
    expect(validationErr.httpStatus).toBe(422);
    expect(validationErr.code).toBe("VALIDATION_ERROR");
  });
});

describe("TASK-027 Unit — Revisioned Edge Cache Key Isolation & Preview Bypass", () => {
  it("builds tenant-isolated, revisioned keys with deterministic query normalization", () => {
    const keyA1 = buildRevisionedCacheKey({
      host: "Alpha-Studio.Situsku.Click.",
      tenantId: "01JTENANT_A",
      cacheVersion: 1,
      pathname: "/blog/",
      searchParams: "?page=2&category=tips",
    });
    const keyA1Reordered = buildRevisionedCacheKey({
      host: "alpha-studio.situsku.click",
      tenantId: "01JTENANT_A",
      cacheVersion: 1,
      pathname: "/blog",
      searchParams: "?category=tips&page=2",
    });
    const keyA2 = buildRevisionedCacheKey({
      host: "alpha-studio.situsku.click",
      tenantId: "01JTENANT_A",
      cacheVersion: 2,
      pathname: "/blog",
      searchParams: "?category=tips&page=2",
    });
    const keyB1 = buildRevisionedCacheKey({
      host: "beta-klinik.situsku.click",
      tenantId: "01JTENANT_B",
      cacheVersion: 1,
      pathname: "/blog",
      searchParams: "?category=tips&page=2",
    });

    expect(keyA1).toBe(
      "https://cache.punyasitus.com/t/01JTENANT_A/v=1/alpha-studio.situsku.click/blog?category=tips&page=2",
    );
    expect(keyA1Reordered).toBe(keyA1);
    expect(keyA2).not.toBe(keyA1);
    expect(keyA2).toContain("/v=2/");
    expect(keyB1).not.toBe(keyA1);

    // page=1 normalizes away
    expect(normalizeSafeQueryParams("?page=1")).toEqual({ ok: true, query: "" });
    // Unknown query param triggers bypass
    expect(normalizeSafeQueryParams("?utm_source=ig")).toEqual({
      ok: false,
      unsupportedKey: "utm_source",
    });
    expect(
      buildRevisionedCacheKey({
        host: "alpha-studio.situsku.click",
        tenantId: "01JTENANT_A",
        cacheVersion: 1,
        pathname: "/",
        searchParams: "?utm_source=fb",
      }),
    ).toBeNull();
  });

  it("strictly bypasses cache for all preview, auth, cookie, method, and non-200 cases", async () => {
    const cache = createMemoryCache();

    // 1. Preview requests NEVER touch cache.match or cache.put and ALWAYS emit private/no-store + noindex
    const previewCases = [
      { req: new Request("https://alpha.situsku.click/"), isPreview: true },
      { req: new Request("https://app.punyasitus.com/dashboard/alpha/preview/page/1"), isPreview: false },
      {
        req: new Request("https://alpha.situsku.click/", {
          headers: { "X-PunyaSitus-Preview": "1" },
        }),
        isPreview: false,
      },
      { req: new Request("https://alpha.situsku.click/?preview=1"), isPreview: false },
    ];

    for (const tc of previewCases) {
      expect(isPreviewRequest(tc.req, { isPreview: tc.isPreview })).toBe(true);
      const res = await serveWithRevisionedEdgeCache({
        request: tc.req,
        tenantId: "01JTENANT_A",
        host: "alpha.situsku.click",
        cacheVersion: 3,
        isPreview: tc.isPreview,
        cache,
        render: () =>
          new Response("<h1>Draft Preview</h1>", {
            status: 200,
            headers: { "Cache-Control": "public, max-age=3600" },
          }),
      });
      expect(res.cacheStatus).toBe("BYPASS");
      expect(res.bypassReason).toBe("preview_request");
      expect(res.response.headers.get("Cache-Control")).toBe(PREVIEW_CACHE_CONTROL);
      expect(res.response.headers.get("X-Robots-Tag")).toBe(PREVIEW_ROBOTS_TAG);
      expect(res.response.headers.get("X-PunyaSitus-Cache")).toBe("BYPASS");
    }
    expect(cache.matchSpy).not.toHaveBeenCalled();
    expect(cache.putSpy).not.toHaveBeenCalled();

    // 2. Session cookie, arbitrary cookie, Authorization, POST all bypass
    const bypassRequests = [
      new Request("https://alpha.situsku.click/", {
        headers: { Cookie: "__Host-ps_session=abc123" },
      }),
      new Request("https://alpha.situsku.click/", {
        headers: { Cookie: "custom_user=1" },
      }),
      new Request("https://alpha.situsku.click/", {
        headers: { Authorization: "Bearer secret" },
      }),
      new Request("https://alpha.situsku.click/", { method: "POST" }),
    ];
    for (const req of bypassRequests) {
      const ev = evaluateCacheBypass(req, {
        tenantId: "01JTENANT_A",
        host: "alpha.situsku.click",
        cacheVersion: 3,
      });
      expect(ev.cacheable).toBe(false);
    }

    // 3. Anonymous consent cookie ONLY stays cacheable
    const consentReq = new Request("https://alpha.situsku.click/", {
      headers: { Cookie: `${TENANT_CONSENT_COOKIE_NAME}=v1:necessary` },
    });
    const consentEval = evaluateCacheBypass(consentReq, {
      tenantId: "01JTENANT_A",
      host: "alpha.situsku.click",
      cacheVersion: 3,
    });
    expect(consentEval.cacheable).toBe(true);

    // 4. Non-200 & no-store responses are NEVER cached
    const notFoundRes = await serveWithRevisionedEdgeCache({
      request: new Request("https://alpha.situsku.click/missing"),
      tenantId: "01JTENANT_A",
      host: "alpha.situsku.click",
      cacheVersion: 3,
      cache,
      render: () => new Response("Not Found", { status: 404 }),
    });
    expect(notFoundRes.cacheStatus).toBe("BYPASS");
    expect(cache.putSpy).not.toHaveBeenCalled();

    const noStoreRes = await serveWithRevisionedEdgeCache({
      request: new Request("https://alpha.situsku.click/private-feed"),
      tenantId: "01JTENANT_A",
      host: "alpha.situsku.click",
      cacheVersion: 3,
      cache,
      render: () =>
        new Response("No Store", { status: 200, headers: { "Cache-Control": "no-store" } }),
    });
    expect(noStoreRes.cacheStatus).toBe("BYPASS");
    expect(cache.putSpy).not.toHaveBeenCalled();

    // 5. Public 200 caches with bounded TTL (clamped <= 60s), Vary, and cache-version header
    let renders = 0;
    const missRes = await serveWithRevisionedEdgeCache({
      request: new Request("https://alpha.situsku.click/"),
      tenantId: "01JTENANT_A",
      host: "alpha.situsku.click",
      cacheVersion: 3,
      ttlSeconds: 9999,
      cache,
      render: () => {
        renders += 1;
        return new Response("<h1>Published v3</h1>", {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      },
    });
    expect(missRes.cacheStatus).toBe("MISS");
    expect(missRes.response.headers.get("Cache-Control")).toBe(
      `public, max-age=${MAX_EDGE_CACHE_TTL_SECONDS}, s-maxage=${MAX_EDGE_CACHE_TTL_SECONDS}`,
    );
    expect(missRes.response.headers.get("Vary")).toContain("Accept-Encoding");
    expect(missRes.response.headers.get("X-PunyaSitus-Cache-Version")).toBe("3");
    expect(renders).toBe(1);

    const hitRes = await serveWithRevisionedEdgeCache({
      request: new Request("https://alpha.situsku.click/"),
      tenantId: "01JTENANT_A",
      host: "alpha.situsku.click",
      cacheVersion: 3,
      cache,
      render: () => {
        renders += 1;
        return new Response("should not render", { status: 200 });
      },
    });
    expect(hitRes.cacheStatus).toBe("HIT");
    expect(await hitRes.response.text()).toBe("<h1>Published v3</h1>");
    expect(renders).toBe(1);
  });
});

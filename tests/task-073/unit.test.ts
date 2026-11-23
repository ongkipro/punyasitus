import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildGoogleBusinessProfileChecklistStep,
  evaluateGoogleBusinessProfileChecklist,
  evaluatePresetChecklist,
  GBP_CHECKLIST_STEP_ID,
  GBP_CHECKLIST_STEP_LABEL,
  GBP_OFFICIAL_HELP_URLS,
} from "@punyasitus/core/presets/index";
import { serializeOpenApiDocument } from "@punyasitus/core/schemas";
import { generateSchemaGraph } from "@punyasitus/core/schema-generator";
import {
  attachGroupedSettingsExtension,
  buildSafeGoogleMapsReviewLink,
  BUSINESS_GROUP_ALLOWED_KEYS,
  createDefaultGroupedSettingsExtension,
  extractGroupedSettingsExtension,
  GOOGLE_BUSINESS_PROFILE_HELP_URL,
  GOOGLE_BUSINESS_PROFILE_REVIEW_HELP_URL,
  GOOGLE_MAPS_REVIEW_DEFAULT_LABEL,
  GOOGLE_MAPS_REVIEW_REL,
  GOOGLE_MAPS_REVIEW_TARGET,
  GOOGLE_MAPS_WRITE_REVIEW_DEFAULT_LABEL,
  PUNYASITUS_GBP_HELP_ARTICLE_PATH,
  SettingsValidationError,
  validateGoogleMapsReviewUrl,
  validateGroupedSettingsPatch,
} from "@punyasitus/core/settings/index";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

describe("TASK-073 Unit: Strict Google Maps Review URL Allowlist & Open-Redirect Guard", () => {
  it("accepts all official PLAN §18.4 Google Maps / Google Review host+path forms", () => {
    const validCases: readonly {
      readonly url: string;
      readonly expectedHost: string;
      readonly expectedKind: "write_review" | "maps_profile" | "short_link";
    }[] = [
      {
        url: "https://g.page/r/Cf1234567890_EBM/review",
        expectedHost: "g.page",
        expectedKind: "write_review",
      },
      {
        url: "https://g.page/klinik-sehat-nusantara/review",
        expectedHost: "g.page",
        expectedKind: "write_review",
      },
      {
        url: "https://g.page/klinik-sehat-nusantara",
        expectedHost: "g.page",
        expectedKind: "maps_profile",
      },
      {
        url: "https://search.google.com/local/writereview?placeid=ChIJN1t_tDeuEmsRUsoyG83frY4",
        expectedHost: "search.google.com",
        expectedKind: "write_review",
      },
      {
        url: "https://maps.google.com/maps?cid=12345678901234567890",
        expectedHost: "maps.google.com",
        expectedKind: "maps_profile",
      },
      {
        url: "https://maps.google.com/maps/place/Klinik+Sehat/@-6.2,106.8,17z",
        expectedHost: "maps.google.com",
        expectedKind: "maps_profile",
      },
      {
        url: "https://www.google.com/maps/place/Klinik+Sehat+Nusantara/@-6.24,106.80,17z",
        expectedHost: "www.google.com",
        expectedKind: "maps_profile",
      },
      {
        url: "https://google.com/maps?cid=9876543210",
        expectedHost: "google.com",
        expectedKind: "maps_profile",
      },
      {
        url: "https://www.google.co.id/maps/place/Bengkel+Nusantara/@-6.91,107.61,15z",
        expectedHost: "www.google.co.id",
        expectedKind: "maps_profile",
      },
      {
        url: "https://maps.app.goo.gl/AbCdEf123456",
        expectedHost: "maps.app.goo.gl",
        expectedKind: "short_link",
      },
    ];

    for (const c of validCases) {
      const res = validateGoogleMapsReviewUrl(c.url);
      expect(res.ok, `Expected valid URL to pass: ${c.url}`).toBe(true);
      if (res.ok) {
        expect(res.hostname).toBe(c.expectedHost);
        expect(res.kind).toBe(c.expectedKind);
        expect(res.target).toBe(GOOGLE_MAPS_REVIEW_TARGET);
        expect(res.rel).toBe(GOOGLE_MAPS_REVIEW_REL);
      }
    }
  });

  it("strictly rejects www.google.com/url open redirects, non-HTTPS, credentials, private IPs, ports, and non-Google domains", () => {
    const rejectedUrls = [
      // Open redirects on Google hosts
      "https://www.google.com/url?q=https://evil.example/phish",
      "https://google.com/url?sa=t&url=https://evil.example",
      "https://www.google.co.id/url?q=https://evil.example",
      "https://maps.google.com/url?q=https://evil.example",
      "https://www.google.com/maps/url?q=https://evil.example",
      "https://search.google.com/url?q=https://evil.example",
      "https://g.page/url",
      "https://maps.app.goo.gl/url",
      // Prefix-trick or bare/non-maps paths
      "https://www.google.com/maps-evil/place/x",
      "https://www.google.com/maps",
      "https://www.google.com/maps/",
      "https://www.google.com/search?q=klinik",
      "https://maps.google.com/",
      "https://g.page/",
      "https://g.page/r/",
      "https://maps.app.goo.gl/",
      "https://search.google.com/local/writereview",
      "https://search.google.com/local/writereview?placeid=short",
      "https://search.google.com/local/reviews?placeid=ChIJN1t_tDeuEmsRUsoyG83frY4",
      // Path traversal
      "https://www.google.com/maps/../url?q=https://evil.example",
      "https://www.google.com/maps/%2e%2e/url?q=https://evil.example",
      // Schemes
      "http://g.page/r/Cf1234567890_EBM/review",
      "http://www.google.com/maps/place/Test",
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      // Credentials & custom ports
      "https://user:pass@g.page/r/Cf1234567890_EBM/review",
      "https://g.page:8443/r/Cf1234567890_EBM/review",
      "https://www.google.com:443/maps/place/Test",
      // Private / loopback IPs & non-Google domains
      "https://127.0.0.1/maps/place/Test",
      "https://localhost/maps/place/Test",
      "https://169.254.169.254/latest/meta-data/",
      "https://google.com.evil.com/maps/place/Test",
      "https://maps.google.com.attacker.id/maps/place/Test",
      "https://example.com/reviews",
      "https://goo.gl/maps/abc123",
      "https://bit.ly/review-kami",
      // Control characters
      "https://g.page/r/Cf1234567890_EBM/review\r\nX-Injected: 1",
    ];

    for (const bad of rejectedUrls) {
      const res = validateGoogleMapsReviewUrl(bad);
      expect(res.ok, `Expected malicious/invalid URL to be rejected: ${bad}`).toBe(false);
      expect(buildSafeGoogleMapsReviewLink(bad)).toBeNull();
    }
  });

  it("integrates googleMapsReviewUrl into business grouped settings validation and fails closed on tampered stored JSON", () => {
    expect(BUSINESS_GROUP_ALLOWED_KEYS.has("googleMapsReviewUrl")).toBe(true);

    const validPatch = validateGroupedSettingsPatch("business", {
      googleMapsReviewUrl: "https://g.page/r/Cf1234567890_EBM/review",
      expectedVersion: 1,
    });
    expect(validPatch.extensionPatch?.business?.googleMapsReviewUrl).toBe(
      "https://g.page/r/Cf1234567890_EBM/review",
    );

    // Clearing with null or empty string yields null
    const clearedNull = validateGroupedSettingsPatch("business", {
      googleMapsReviewUrl: null,
      expectedVersion: 2,
    });
    expect(clearedNull.extensionPatch?.business?.googleMapsReviewUrl).toBeNull();

    const clearedEmpty = validateGroupedSettingsPatch("business", {
      googleMapsReviewUrl: "   ",
      expectedVersion: 2,
    });
    expect(clearedEmpty.extensionPatch?.business?.googleMapsReviewUrl).toBeNull();

    // Open redirect throws SettingsValidationError on googleMapsReviewUrl field
    let caught: unknown = null;
    try {
      validateGroupedSettingsPatch("business", {
        googleMapsReviewUrl: "https://www.google.com/url?q=https://evil.example",
        expectedVersion: 2,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SettingsValidationError);
    expect((caught as SettingsValidationError).fields[0]?.field).toBe("googleMapsReviewUrl");
    expect((caught as SettingsValidationError).fields[0]?.code).toBe(
      "INVALID_GOOGLE_MAPS_REVIEW_URL",
    );

    // Tampered stored envelope fails closed to null
    const tamperedEnvelope = JSON.stringify({
      snapshotVersion: 1,
      _groupedSettings: {
        ...createDefaultGroupedSettingsExtension(),
        business: {
          googleMapsReviewUrl: "https://www.google.com/url?q=https://evil.example",
        },
      },
    });
    expect(extractGroupedSettingsExtension(tamperedEnvelope).business.googleMapsReviewUrl).toBeNull();

    // Valid stored envelope round-trips cleanly
    const validEnvelope = attachGroupedSettingsExtension(
      JSON.stringify({ snapshotVersion: 1, data: {} }),
      {
        ...createDefaultGroupedSettingsExtension(),
        business: {
          googleMapsReviewUrl: "https://maps.app.goo.gl/AbCdEf123456",
        },
      },
    );
    expect(extractGroupedSettingsExtension(validEnvelope).business.googleMapsReviewUrl).toBe(
      "https://maps.app.goo.gl/AbCdEf123456",
    );
  });

  it("builds safe plain links with appropriate labels and rel attributes", () => {
    const writeLink = buildSafeGoogleMapsReviewLink("https://g.page/r/Cf1234567890_EBM/review");
    expect(writeLink).toMatchObject({
      href: "https://g.page/r/Cf1234567890_EBM/review",
      label: GOOGLE_MAPS_WRITE_REVIEW_DEFAULT_LABEL,
      target: "_blank",
      rel: "noopener noreferrer nofollow",
      kind: "write_review",
    });

    const profileLink = buildSafeGoogleMapsReviewLink(
      "https://www.google.com/maps/place/Klinik+Sehat/@-6.2,106.8,17z",
    );
    expect(profileLink).toMatchObject({
      label: GOOGLE_MAPS_REVIEW_DEFAULT_LABEL,
      target: "_blank",
      rel: "noopener noreferrer nofollow",
      kind: "maps_profile",
    });
  });
});

describe("TASK-073 Unit: GBP Checklist, Zero Rating Schema & Boundary Guardrails", () => {
  it("provides the Google Business Profile checklist step linking to official Google Help & PunyaSitus /bantuan article", () => {
    const step = buildGoogleBusinessProfileChecklistStep({
      handle: "klinik-sehat",
      publicSiteHref: "https://klinik-sehat.situsku.click",
      googleMapsReviewUrl: null,
      hasPublishedReviewUrl: false,
    });

    expect(step.id).toBe(GBP_CHECKLIST_STEP_ID);
    expect(step.label).toBe(GBP_CHECKLIST_STEP_LABEL);
    expect(step.requiredForPublish).toBe(false);
    expect(step.status).toBe("optional_pending");
    expect(step.officialHelpUrl).toBe(GOOGLE_BUSINESS_PROFILE_HELP_URL);
    expect(step.officialReviewLinkHelpUrl).toBe(GOOGLE_BUSINESS_PROFILE_REVIEW_HELP_URL);
    expect(step.helpArticleHref).toBe(PUNYASITUS_GBP_HELP_ARTICLE_PATH);
    expect(step.officialHelpUrl).toMatch(/^https:\/\/support\.google\.com\/business\//);
    expect(step.helpArticleHref).toMatch(/^\/bantuan\//);
    expect(step.manualSteps.length).toBeGreaterThanOrEqual(3);

    // Verify PunyaSitus help article actually exists on disk!
    const helpMdPath = path.join(
      REPO_ROOT,
      "apps/web/src/content/bantuan",
      `${PUNYASITUS_GBP_HELP_ARTICLE_PATH.replace(/^\/bantuan\//, "")}.md`,
    );
    expect(fs.existsSync(helpMdPath)).toBe(true);

    // Card summary transitions cleanly from pending to completed
    const cardPending = evaluateGoogleBusinessProfileChecklist({
      handle: "klinik-sehat",
      publicSiteHref: "https://klinik-sehat.situsku.click",
      googleMapsReviewUrl: null,
      hasPublishedReviewUrl: false,
      isSitePublished: true,
    });
    expect(cardPending.completedCount).toBe(1);
    expect(cardPending.totalCount).toBe(3);

    const cardDone = evaluateGoogleBusinessProfileChecklist({
      handle: "klinik-sehat",
      publicSiteHref: "https://klinik-sehat.situsku.click",
      googleMapsReviewUrl: "https://g.page/r/Cf1234567890_EBM/review",
      hasPublishedReviewUrl: true,
      isSitePublished: true,
    });
    expect(cardDone.completedCount).toBe(3);
    expect(cardDone.step.status).toBe("done");

    // Opt-in in evaluatePresetChecklist appends GBP step without breaking legacy 6-item callers
    const withGbp = evaluatePresetChecklist({
      handle: "klinik-sehat",
      siteTitle: "Klinik Sehat",
      businessName: "Klinik Sehat Nusantara",
      hasCustomizedDraftSection: true,
      nonTrashedPagesCount: 1,
      nonTrashedOfferingsCount: 0,
      whatsappE164: "+6281234567890",
      phone: null,
      email: "halo@klinik.co.id",
      hasPrivacyPage: false,
      hasPreviewedPreset: true,
      activeCustomHostname: null,
      fallbackHost: "klinik-sehat.situsku.click",
      googleMapsReviewUrl: "https://maps.app.goo.gl/AbCdEf123456",
      hasPublishedGoogleMapsReviewUrl: true,
    });
    const gbpItem = withGbp.items.find((i) => i.id === "google_business_profile");
    expect(gbpItem).toBeDefined();
    expect(gbpItem?.label).toBe(GBP_CHECKLIST_STEP_LABEL);
    expect(gbpItem?.officialHelpUrl).toBe(GBP_OFFICIAL_HELP_URLS.addWebsiteToProfile);
    expect(gbpItem?.helpArticleHref).toBe(GBP_OFFICIAL_HELP_URLS.punyasitusHelpArticle);
    expect(gbpItem?.status).toBe("done");
  });

  it("emits ZERO Review or AggregateRating JSON-LD schema when building tenant schema graphs", () => {
    const res = generateSchemaGraph({
      seo: {
        routeKind: "homepage",
        pathname: "/",
        siteVisibility: "public",
        resourceState: "published",
        tenant: {
          tenantHandle: "klinik-sehat",
          tenantStatus: "active",
          primaryHost: "klinik-sehat.situsku.click",
          primaryHostKind: "subdomain",
          primaryHostStatus: "active",
          primaryHostSslStatus: "active",
          primaryHostVerified: true,
        },
      },
      siteName: "Klinik Sehat Nusantara",
      business: {
        businessName: "Klinik Sehat Nusantara",
        businessCategory: "LocalBusiness",
        mapsUrl: "https://maps.google.com/maps?cid=1234567890",
        phone: "62215551234",
      },
    });
    expect(res.emitted).toBe(true);
    const serialized = res.jsonLd ?? JSON.stringify(res.graph);
    expect(serialized).not.toContain('"AggregateRating"');
    expect(serialized).not.toContain('"Review"');
    expect(serialized).not.toContain("ratingValue");
    expect(serialized).not.toContain("reviewCount");
  });

  it("enforces TASK-013 & TASK-032 public-section guardrails, zero widgets, and zero OpenAPI drift", () => {
    const publicSectionFiles = [
      "apps/web/src/themes/default/sections/SectionTestimonials.astro",
      "apps/web/src/themes/default/sections/SectionContactForm.astro",
    ];
    const forbiddenSubstrings = [
      "@radix-ui/",
      "@base-ui/react",
      "react",
      "@punyasitus/db",
      "@punyasitus/auth",
      "client:",
      "components/ui",
      "Sparkles",
      "AggregateRating",
      '"@type": "Review"',
      '"@type":"Review"',
    ];

    for (const rel of publicSectionFiles) {
      const content = fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
      for (const bad of forbiddenSubstrings) {
        expect(content, `${rel} must not contain "${bad}"`).not.toContain(bad);
      }
      expect(content).toContain("buildSafeGoogleMapsReviewLink");
    }

    // Also verify zero Sparkles / Radix / asChild in _GroupedSettingsWorkspace.tsx
    const settingsUi = fs.readFileSync(
      path.join(
        REPO_ROOT,
        "apps/web/src/pages/dashboard/[handle]/settings/_GroupedSettingsWorkspace.tsx",
      ),
      "utf8",
    );
    expect(settingsUi).not.toContain("@radix-ui/");
    expect(settingsUi).not.toMatch(/\basChild\b/);
    expect(settingsUi).not.toMatch(/\bSparkles(?:Icon)?\b/);

    // Verify docs/api/gbp-review-link.md exists & openapi.json has zero drift
    expect(fs.existsSync(path.join(REPO_ROOT, "docs/api/gbp-review-link.md"))).toBe(true);
    const committedOpenApi = fs.readFileSync(path.join(REPO_ROOT, "docs/api/openapi.json"), "utf8");
    expect(committedOpenApi).toBe(serializeOpenApiDocument());
  });
});

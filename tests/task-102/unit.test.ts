import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { generateOpenGraphMetadata, OG_IMAGE_MAX_BYTES } from "@punyasitus/core/og-generator";
import { validatePluginManifest } from "@punyasitus/core/plugins/index";
import { B2B_BLUEPRINT_IDS } from "@punyasitus/core/presets/blueprints";
import {
  AI_TRAINING_ONLY_CRAWLERS,
  ALLOWED_SEARCH_AND_AI_FETCHERS,
  isPathAllowedByRobotsTxt,
} from "@punyasitus/core/seo/robots";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ACTIVE_ON_PROVISION_PLUGIN_IDS,
  DEFAULT_PLUGIN_REGISTRY,
  getRegisteredPlugin,
  isDefaultActiveOnProvisionPlugin,
  REGISTERED_FIRST_PARTY_PLUGINS,
} from "../../apps/web/src/core/plugin-registry.ts";
import {
  buildAutopilotDirectoryCopyCard,
  buildAutopilotImageSitemapXml,
  buildAutopilotIndexNowPing,
  buildAutopilotPluginDashboardModel,
  buildAutopilotRobotsTxt,
  buildAutopilotSitemapIndexXml,
  buildMinimalFallbackRobotsTxt,
  checkSeoAutopilotActiveInTenantDb,
  deriveDeterministicTenantIndexNowKey,
  dispatchAutopilotIndexNowPing,
  evaluateAutopilotBlogFeedGate,
  evaluateAutopilotSitemapGate,
  generateAutopilotBlueprintMeta,
  isSeoAutopilotActiveInTenantDb,
  renderAutopilotSeoHead,
  resolveAutopilotEditorSlot,
  resolveAutopilotIndexNowKey,
  resolveAutopilotSchemaGraph,
  resolveAutopilotWhatsAppOgMetadata,
  resolveSeoAutopilotActiveFromLocals,
  SEO_AI_AUTOPILOT_CAPABILITIES,
  SEO_AI_AUTOPILOT_DEFAULT_ACTIVE_ON_PROVISION,
  SEO_AI_AUTOPILOT_MANIFEST,
  SEO_AI_AUTOPILOT_METADATA,
  SEO_AI_AUTOPILOT_PLUGIN,
  SEO_AI_AUTOPILOT_PLUGIN_ID,
  SEO_AI_AUTOPILOT_TABLE_PREFIX,
  verifyAutopilotIndexNowKeyFile,
} from "../../packages/plugins/seo-ai-autopilot/index.ts";

const ROOT = path.resolve(import.meta.dirname, "../..");
const WEB_DIR = path.join(ROOT, "apps/web");

const ACTIVE_TENANT = {
  tenantHandle: "nusantara-arsitek",
  tenantStatus: "active" as const,
  operatorHold: false,
  primaryHost: "www.nusantara-arsitek.id",
  primaryHostKind: "custom" as const,
  primaryHostStatus: "active" as const,
  primaryHostSslStatus: "active",
  primaryHostVerified: true,
  verifiedTenantHosts: ["www.nusantara-arsitek.id", "nusantara-arsitek.situsku.click"],
  servingHost: "www.nusantara-arsitek.id",
};

const TRIAL_TENANT = {
  tenantHandle: "coba-bisnis",
  tenantStatus: "trial" as const,
  operatorHold: false,
  primaryHost: "coba-bisnis.situsku.click",
  primaryHostKind: "subdomain" as const,
  primaryHostStatus: "active" as const,
  primaryHostSslStatus: "active",
  primaryHostVerified: true,
  verifiedTenantHosts: ["coba-bisnis.situsku.click"],
  servingHost: "coba-bisnis.situsku.click",
};

const SUSPENDED_TENANT = {
  ...ACTIVE_TENANT,
  tenantStatus: "suspended" as const,
};

describe("TASK-102: Official Free Zero-Config Plugin seo-ai-autopilot Unit Tests", () => {
  it("validates manifest, DEC-042 default-active metadata, tablePrefix isolation, and static plugin registry wiring", () => {
    const validated = validatePluginManifest(SEO_AI_AUTOPILOT_MANIFEST);
    expect(validated.id).toBe("seo-ai-autopilot");
    expect(validated.visibility).toBe("public_free");
    expect(validated.billingCycle).toBe("free");
    expect(validated.priceIdr).toBe(0);
    expect(validated.tablePrefix).toBe("plg_seo_ai_autopilot__");
    expect(validated.maxPublicJsBytes).toBe(0);

    expect(SEO_AI_AUTOPILOT_PLUGIN_ID).toBe("seo-ai-autopilot");
    expect(SEO_AI_AUTOPILOT_TABLE_PREFIX).toBe("plg_seo_ai_autopilot__");
    expect(SEO_AI_AUTOPILOT_DEFAULT_ACTIVE_ON_PROVISION).toBe(true);
    expect(SEO_AI_AUTOPILOT_METADATA.slug).toBe("seo-ai-autopilot");
    expect(SEO_AI_AUTOPILOT_METADATA.tier).toBe("public_free");
    expect(SEO_AI_AUTOPILOT_METADATA.defaultActiveOnProvision).toBe(true);
    expect(SEO_AI_AUTOPILOT_METADATA.zeroConfigRequired).toBe(true);
    expect(SEO_AI_AUTOPILOT_METADATA.mandatoryFieldCount).toBe(0);
    expect(SEO_AI_AUTOPILOT_METADATA.preservesOverridesOnDisable).toBe(true);
    expect(SEO_AI_AUTOPILOT_CAPABILITIES.length).toBeGreaterThanOrEqual(8);

    // Statically registered in apps/web/src/core/plugin-registry.ts
    expect(REGISTERED_FIRST_PARTY_PLUGINS).toContain(SEO_AI_AUTOPILOT_PLUGIN);
    expect(DEFAULT_PLUGIN_REGISTRY.has("seo-ai-autopilot")).toBe(true);
    expect(getRegisteredPlugin("seo-ai-autopilot")?.manifest.id).toBe("seo-ai-autopilot");
    expect(DEFAULT_ACTIVE_ON_PROVISION_PLUGIN_IDS).toContain("seo-ai-autopilot");
    expect(isDefaultActiveOnProvisionPlugin("seo-ai-autopilot")).toBe(true);
    expect(isDefaultActiveOnProvisionPlugin("unknown-plugin")).toBe(false);
  });

  it("generates zero-config programmatic Blueprint Meta Title & Description across all 7 B2B blueprints and route kinds", () => {
    for (const bpId of B2B_BLUEPRINT_IDS) {
      const homeMeta = generateAutopilotBlueprintMeta({
        routeKind: "homepage",
        profile: {
          siteName: "PT Karya Nusantara",
          businessName: "PT Karya Nusantara",
          city: "Jakarta Selatan",
          primaryService: "Renovasi Kantor",
          blueprintId: bpId,
        },
      });

      expect(homeMeta.blueprintId).toBe(bpId);
      expect(homeMeta.title.length).toBeGreaterThan(8);
      expect(homeMeta.title.length).toBeLessThanOrEqual(70);
      expect(homeMeta.description.length).toBeGreaterThan(20);
      expect(homeMeta.description.length).toBeLessThanOrEqual(160);
      expect(homeMeta.title).not.toContain("{{");
      expect(homeMeta.description).not.toContain("{{");
      expect(homeMeta.zeroConfigDerived).toBe(true);
    }

    // Distinct route kinds produce distinct non-duplicated titles + pagination qualifier
    const pageMeta = generateAutopilotBlueprintMeta({
      routeKind: "page",
      profile: { siteName: "PT Nusantara Arsitek", vertical: "compro", city: "Bandung" },
      title: "Tentang Kami",
    });
    const offeringMeta = generateAutopilotBlueprintMeta({
      routeKind: "offering",
      offeringType: "service",
      profile: { siteName: "PT Nusantara Arsitek", vertical: "compro", city: "Bandung" },
      title: "Jasa Renovasi Kantor",
    });
    const postMeta = generateAutopilotBlueprintMeta({
      routeKind: "post",
      profile: { siteName: "PT Nusantara Arsitek", vertical: "compro" },
      title: "Cara Memilih Kontraktor Interior",
      excerpt: "Panduan praktis memeriksa portofolio dan RAB renovasi ruang kerja.",
      category: "Panduan",
    });
    const archivePage2 = generateAutopilotBlueprintMeta({
      routeKind: "blog_index",
      profile: { siteName: "PT Nusantara Arsitek" },
      pageNumber: 2,
    });

    expect(pageMeta.title).toContain("Tentang Kami");
    expect(offeringMeta.title).toContain("Jasa Renovasi Kantor");
    expect(offeringMeta.title).toContain("Bandung");
    expect(postMeta.description).toContain("Panduan praktis");
    expect(postMeta.descriptionSource).toBe("content_excerpt");
    expect(archivePage2.title).toContain("Halaman 2");
    expect(new Set([pageMeta.title, offeringMeta.title, postMeta.title, archivePage2.title]).size).toBe(4);

    // Explicit manual override takes precedence
    const overridden = generateAutopilotBlueprintMeta({
      routeKind: "page",
      profile: { siteName: "PT Nusantara Arsitek" },
      title: "Kontak",
      titleOverride: "Hubungi Arsitek Jakarta",
      descriptionOverride: "Konsultasi desain kantor gratis via WhatsApp resmi.",
    });
    expect(overridden.title).toBe("Hubungi Arsitek Jakarta");
    expect(overridden.titleSource).toBe("manual_override");
    expect(overridden.descriptionSource).toBe("manual_override");
    expect(overridden.zeroConfigDerived).toBe(false);
  });

  it("enforces < 300 KiB 1200x630 WhatsApp-safe OG image selection and safe fallback downgrade", () => {
    const validOg = resolveAutopilotWhatsAppOgMetadata({
      seo: {
        surface: "public_tenant",
        routeKind: "offering",
        pathname: "/layanan/renovasi-kantor",
        tenant: ACTIVE_TENANT,
        siteVisibility: "public",
        resourceState: "published",
      },
      tenantId: "tenant_a",
      siteName: "PT Nusantara Arsitek",
      resourceTitle: "Renovasi Kantor",
      offeringType: "service",
      blueprintProfile: {
        siteName: "PT Nusantara Arsitek",
        city: "Jakarta",
        blueprintId: "b2b_corporate",
      },
      resourceMedia: {
        id: 10,
        kind: "image",
        status: "ready",
        r2Key: "t/tenant_a/media/10/master.webp",
        altText: "Ruang kerja modern",
        variants: {
          slug: "ruang-kerja-modern",
          master: {
            key: "t/tenant_a/media/10/master.webp",
            width: 1920,
            height: 1080,
            bytes: 340_000,
            mimeType: "image/webp",
          },
          w1280: {
            key: "t/tenant_a/media/10/w1280.webp",
            width: 1280,
            height: 720,
            bytes: 195_000,
            mimeType: "image/webp",
          },
          w640: {
            key: "t/tenant_a/media/10/w640.webp",
            width: 640,
            height: 360,
            bytes: 82_000,
            mimeType: "image/webp",
          },
          thumb: {
            key: "t/tenant_a/media/10/thumb.webp",
            width: 320,
            height: 180,
            bytes: 28_000,
            mimeType: "image/webp",
          },
          og: {
            key: "t/tenant_a/media/10/og.webp",
            width: 1200,
            height: 630,
            bytes: 185_000,
            mimeType: "image/webp",
          },
        },
      },
    });

    expect(validOg.whatsAppSafeImage).toBe(true);
    expect(validOg.imageByteLimitBytes).toBe(OG_IMAGE_MAX_BYTES);
    expect(validOg.metadata.og.image?.byteSize).toBeLessThanOrEqual(OG_IMAGE_MAX_BYTES);
    expect(validOg.metadata.twitter.card).toBe("summary_large_image");

    // Oversized > 300 KiB OG candidate is rejected and safely downgrades twitter:card to "summary"
    const oversized = resolveAutopilotWhatsAppOgMetadata({
      seo: {
        surface: "public_tenant",
        routeKind: "page",
        pathname: "/tentang",
        tenant: ACTIVE_TENANT,
        siteVisibility: "public",
        resourceState: "published",
      },
      tenantId: "tenant_a",
      siteName: "PT Nusantara Arsitek",
      resourceTitle: "Tentang Kami",
      resourceOgImage: {
        tenantId: "tenant_a",
        status: "ready",
        r2Key: "t/tenant_a/media/11/og.webp",
        url: "https://media.punyasitus.com/t/tenant_a/media/11/og.webp",
        width: 1200,
        height: 630,
        byteSize: OG_IMAGE_MAX_BYTES + 1,
        mimeType: "image/webp",
      },
    });

    expect(oversized.whatsAppSafeImage).toBe(false);
    expect(oversized.metadata.og.image).toBeNull();
    expect(oversized.metadata.twitter.card).toBe("summary");
    expect(oversized.metadata.imageRejections.some((r) => r.reason === "oversized")).toBe(true);
  });

  it("gates Schema.org @graph and renders active vs minimal-disabled <head> while preserving trial/suspended noindex safety", () => {
    const schemaInput = {
      seo: {
        surface: "public_tenant" as const,
        routeKind: "homepage" as const,
        pathname: "/",
        tenant: ACTIVE_TENANT,
        siteVisibility: "public" as const,
        resourceState: "published" as const,
      },
      tenantId: "tenant_a",
      siteName: "PT Nusantara Arsitek",
      business: {
        businessName: "PT Nusantara Arsitek",
        businessCategory: "b2b_corporate",
      },
      pageTitle: "Beranda",
    };

    const enabledSchema = resolveAutopilotSchemaGraph(schemaInput, { seoAutopilotActive: true });
    expect(enabledSchema.emitted).toBe(true);
    expect(enabledSchema.result?.graph?.["@graph"]?.length).toBeGreaterThan(0);

    const disabledSchema = resolveAutopilotSchemaGraph(schemaInput, { seoAutopilotActive: false });
    expect(disabledSchema.emitted).toBe(false);
    expect(disabledSchema.result).toBeNull();
    expect(disabledSchema.reason).toBe("plugin_disabled");

    // Paid active page with plugin ACTIVE -> full OG + JSON-LD + canonical + verification + RSS
    const activeMeta = generateOpenGraphMetadata({
      seo: schemaInput.seo,
      tenantId: "tenant_a",
      siteName: "PT Nusantara Arsitek",
      resourceTitle: "Beranda",
      resourceExcerpt: "Jasa arsitek dan renovasi kantor.",
    });

    const headActive = renderAutopilotSeoHead({
      metadata: activeMeta,
      seoAutopilotActive: true,
      jsonLd: enabledSchema.result?.graph,
      publishedVerificationTokens: { google: "gscTokenVerified_2026", bing: null, yandex: null },
      blogEnabled: true,
      siteName: "PT Nusantara Arsitek",
    });
    expect(headActive.mode).toBe("autopilot_active");
    expect(headActive.schemaEmitted).toBe(true);
    expect(headActive.ogEmitted).toBe(true);
    expect(headActive.html).toContain('<link rel="canonical"');
    expect(headActive.html).toContain('property="og:title"');
    expect(headActive.html).toContain('type="application/ld+json"');
    expect(headActive.html).toContain('name="google-site-verification"');
    expect(headActive.html).toContain("/blog/feed.xml");

    // Paid active page with plugin DISABLED -> minimal <title> ONLY, ZERO OG, ZERO JSON-LD, ZERO verification
    const headDisabledPaid = renderAutopilotSeoHead({
      metadata: activeMeta,
      seoAutopilotActive: false,
      jsonLd: enabledSchema.result?.graph,
      publishedVerificationTokens: { google: "gscTokenVerified_2026", bing: null, yandex: null },
      blogEnabled: true,
      siteName: "PT Nusantara Arsitek",
    });
    expect(headDisabledPaid.mode).toBe("minimal_disabled");
    expect(headDisabledPaid.schemaEmitted).toBe(false);
    expect(headDisabledPaid.ogEmitted).toBe(false);
    expect(headDisabledPaid.html).toContain("<title>");
    expect(headDisabledPaid.html).not.toContain('property="og:');
    expect(headDisabledPaid.html).not.toContain('name="twitter:');
    expect(headDisabledPaid.html).not.toContain('type="application/ld+json"');
    expect(headDisabledPaid.html).not.toContain("google-site-verification");
    expect(headDisabledPaid.html).not.toContain("/blog/feed.xml");

    // Trial tenant with plugin DISABLED -> MUST keep mandatory `<meta name="robots" content="noindex, nofollow" />`!
    const trialMeta = generateOpenGraphMetadata({
      seo: {
        surface: "public_tenant",
        routeKind: "homepage",
        pathname: "/",
        tenant: TRIAL_TENANT,
        siteVisibility: "public",
        resourceState: "published",
      },
      siteName: "Coba Bisnis",
    });
    const headDisabledTrial = renderAutopilotSeoHead({
      metadata: trialMeta,
      seoAutopilotActive: false,
      jsonLd: enabledSchema.result?.graph,
    });
    expect(headDisabledTrial.mode).toBe("minimal_disabled");
    expect(headDisabledTrial.robotsEmitted).toBe(true);
    expect(headDisabledTrial.html).toContain("<title>");
    expect(headDisabledTrial.html).toContain('<meta name="robots" content="noindex, nofollow" />');
    expect(headDisabledTrial.html).not.toContain('type="application/ld+json"');
    expect(headDisabledTrial.html).not.toContain('property="og:');

    // Suspended tenant with plugin DISABLED -> MUST keep mandatory `noindex, nofollow`!
    const suspendedMeta = generateOpenGraphMetadata({
      seo: {
        surface: "public_tenant",
        routeKind: "homepage",
        pathname: "/",
        tenant: SUSPENDED_TENANT,
        siteVisibility: "public",
        resourceState: "published",
      },
      siteName: "PT Nusantara Arsitek",
    });
    const headDisabledSuspended = renderAutopilotSeoHead({
      metadata: suspendedMeta,
      seoAutopilotActive: false,
    });
    expect(headDisabledSuspended.html).toContain(
      '<meta name="robots" content="noindex, nofollow" />',
    );
    expect(headDisabledSuspended.html).not.toContain('type="application/ld+json"');
  });

  it("generates AI-split robots.txt when active vs clean minimal fallback when disabled, and gates sitemaps & RSS cleanly", () => {
    const robotsAllow = buildAutopilotRobotsTxt({
      tenant: ACTIVE_TENANT,
      aiTrainingPolicy: "allow",
      siteVisibility: "public",
      seoAutopilotActive: true,
    });
    expect(robotsAllow.mode).toBe("ai_split_autopilot");
    expect(robotsAllow.body).toContain("Sitemap: https://www.nusantara-arsitek.id/sitemap.xml");
    for (const bot of ALLOWED_SEARCH_AND_AI_FETCHERS) {
      expect(isPathAllowedByRobotsTxt(robotsAllow.body, bot, "/")).toBe(true);
    }
    for (const bot of AI_TRAINING_ONLY_CRAWLERS) {
      expect(isPathAllowedByRobotsTxt(robotsAllow.body, bot, "/")).toBe(true);
    }

    const robotsDisallowTraining = buildAutopilotRobotsTxt({
      tenant: ACTIVE_TENANT,
      aiTrainingPolicy: "disallow",
      siteVisibility: "public",
      seoAutopilotActive: true,
    });
    for (const bot of ALLOWED_SEARCH_AND_AI_FETCHERS) {
      expect(isPathAllowedByRobotsTxt(robotsDisallowTraining.body, bot, "/layanan")).toBe(true);
    }
    for (const bot of AI_TRAINING_ONLY_CRAWLERS) {
      expect(isPathAllowedByRobotsTxt(robotsDisallowTraining.body, bot, "/")).toBe(false);
    }

    // Disabled on active paid site -> minimal safe fallback (NO Sitemap:, NO AI bot split, KEEPS Disallow: /api/)
    const robotsDisabled = buildAutopilotRobotsTxt({
      tenant: ACTIVE_TENANT,
      aiTrainingPolicy: "disallow",
      siteVisibility: "public",
      seoAutopilotActive: false,
    });
    expect(robotsDisabled.mode).toBe("minimal_disabled_fallback");
    expect(robotsDisabled.body).toBe(buildMinimalFallbackRobotsTxt());
    expect(robotsDisabled.body).toContain("Disallow: /api/");
    expect(robotsDisabled.body).not.toContain("Sitemap:");
    expect(robotsDisabled.body).not.toContain("GPTBot");
    expect(robotsDisabled.body).not.toContain("OAI-SearchBot");

    // Disabled on trial site -> STILL emits mandatory Disallow: / safety!
    const robotsDisabledTrial = buildAutopilotRobotsTxt({
      tenant: TRIAL_TENANT,
      aiTrainingPolicy: "allow",
      siteVisibility: "public",
      seoAutopilotActive: false,
    });
    expect(robotsDisabledTrial.mode).toBe("safety_disallow_all");
    expect(robotsDisabledTrial.body).toBe("User-agent: *\nDisallow: /\n");

    // Sitemap & Image Sitemap gate + XML builder
    expect(
      evaluateAutopilotSitemapGate({
        seoAutopilotActive: false,
        tenantStatus: "active",
        siteVisibility: "public",
      }),
    ).toEqual({ allowed: false, httpStatus: 404, reason: "plugin_disabled" });
    expect(
      evaluateAutopilotSitemapGate({
        seoAutopilotActive: true,
        tenantStatus: "active",
        siteVisibility: "public",
      }),
    ).toEqual({ allowed: true, httpStatus: 200, reason: "active" });

    const imageSitemapXml = buildAutopilotImageSitemapXml([
      {
        loc: "https://www.nusantara-arsitek.id/layanan/renovasi-kantor",
        lastmod: "2026-11-23T08:00:00.000Z",
        images: [
          {
            loc: "https://media.punyasitus.com/t/tenant_a/media/10/w1280.webp",
            title: "Renovasi & Desain <Modern>",
          },
        ],
      },
    ]);
    expect(imageSitemapXml).toContain('xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"');
    expect(imageSitemapXml).toContain("<image:loc>https://media.punyasitus.com/t/tenant_a/media/10/w1280.webp</image:loc>");
    expect(imageSitemapXml).toContain("<image:title>Renovasi &amp; Desain &lt;Modern&gt;</image:title>");

    const sitemapIndexXml = buildAutopilotSitemapIndexXml([
      {
        loc: "https://www.nusantara-arsitek.id/sitemaps/pages.xml",
        lastmod: "2026-11-23T08:00:00.000Z",
      },
    ]);
    expect(sitemapIndexXml).toContain("<sitemapindex");
    expect(sitemapIndexXml).toContain("https://www.nusantara-arsitek.id/sitemaps/pages.xml");

    // Blog RSS gate
    expect(
      evaluateAutopilotBlogFeedGate({
        seoAutopilotActive: false,
        blogEnabled: true,
        tenantStatus: "active",
      }),
    ).toEqual({ allowed: false, httpStatus: 404, reason: "plugin_disabled" });
    expect(
      evaluateAutopilotBlogFeedGate({
        seoAutopilotActive: true,
        blogEnabled: true,
        tenantStatus: "active",
      }),
    ).toEqual({ allowed: true, httpStatus: 200, reason: "active" });
  });

  it("derives deterministic tenant-scoped IndexNow keys, returns 404 when disabled, and never calls live network in dry-run", async () => {
    const keyA1 = await deriveDeterministicTenantIndexNowKey("01JT102TENANTA000000000001");
    const keyA2 = await deriveDeterministicTenantIndexNowKey("01JT102TENANTA000000000001");
    const keyB = await deriveDeterministicTenantIndexNowKey("01JT102TENANTB000000000002");

    expect(keyA1).toBe(keyA2);
    expect(keyA1).toMatch(/^[a-f0-9]{32}$/);
    expect(keyA1).not.toBe(keyB);

    // Disabled plugin resolves to null and verification returns 404
    expect(
      await resolveAutopilotIndexNowKey({
        tenantId: "01JT102TENANTA000000000001",
        seoAutopilotActive: false,
        storedKey: keyA1,
      }),
    ).toBeNull();

    const verifiedDisabled = await verifyAutopilotIndexNowKeyFile({
      tenantId: "01JT102TENANTA000000000001",
      candidateKey: keyA1,
      eligibility: {
        tenantStatus: "active",
        primaryHost: "www.nusantara-arsitek.id",
        primaryHostKind: "custom",
        primaryHostStatus: "active",
        primaryHostSslStatus: "active",
        primaryHostVerified: true,
        siteVisibility: "public",
        seoAutopilotEnabled: false,
      },
    });
    expect(verifiedDisabled.ok).toBe(false);
    if (!verifiedDisabled.ok) {
      expect(verifiedDisabled.status).toBe(404);
      expect(verifiedDisabled.reason).toBe("seo_autopilot_disabled");
    }

    // Active plugin verifies deterministically with ZERO stored key config!
    const verifiedActive = await verifyAutopilotIndexNowKeyFile({
      tenantId: "01JT102TENANTA000000000001",
      candidateKey: keyA1,
      eligibility: {
        tenantStatus: "active",
        primaryHost: "www.nusantara-arsitek.id",
        primaryHostKind: "custom",
        primaryHostStatus: "active",
        primaryHostSslStatus: "active",
        primaryHostVerified: true,
        siteVisibility: "public",
        seoAutopilotEnabled: true,
      },
    });
    expect(verifiedActive.ok).toBe(true);
    if (verifiedActive.ok) {
      expect(verifiedActive.key).toBe(keyA1);
      expect(verifiedActive.keyLocation).toBe(`https://www.nusantara-arsitek.id/${keyA1}.txt`);
    }

    // Build payload + dry-run (default when no fetchImpl) + mock fetch port
    const pingBuilt = await buildAutopilotIndexNowPing({
      tenantId: "01JT102TENANTA000000000001",
      eligibility: {
        tenantStatus: "active",
        primaryHost: "www.nusantara-arsitek.id",
        primaryHostKind: "custom",
        primaryHostStatus: "active",
        primaryHostSslStatus: "active",
        primaryHostVerified: true,
        siteVisibility: "public",
        seoAutopilotEnabled: true,
      },
      urls: ["/", "/layanan/renovasi?utm_source=ig", "/api/secret", "/layanan/renovasi"],
    });
    expect(pingBuilt.ready).toBe(true);
    if (pingBuilt.ready) {
      expect(pingBuilt.payload.urlList).toEqual([
        "https://www.nusantara-arsitek.id/",
        "https://www.nusantara-arsitek.id/layanan/renovasi",
      ]);
    }

    // Default dispatch without fetchImpl stays dryRun (never makes live network calls)
    const dryRes = await dispatchAutopilotIndexNowPing({
      tenantId: "01JT102TENANTA000000000001",
      eligibility: {
        tenantStatus: "active",
        primaryHost: "www.nusantara-arsitek.id",
        primaryHostKind: "custom",
        primaryHostStatus: "active",
        primaryHostSslStatus: "active",
        primaryHostVerified: true,
        siteVisibility: "public",
        seoAutopilotEnabled: true,
      },
      urls: ["/"],
    });
    expect(dryRes.dryRun).toBe(true);
    expect(dryRes.dispatched).toBe(false);

    // Mockable fetch port executes cleanly
    let fetchCalls = 0;
    const mockRes = await dispatchAutopilotIndexNowPing(
      {
        tenantId: "01JT102TENANTA000000000001",
        eligibility: {
          tenantStatus: "active",
          primaryHost: "www.nusantara-arsitek.id",
          primaryHostKind: "custom",
          primaryHostStatus: "active",
          primaryHostSslStatus: "active",
          primaryHostVerified: true,
          siteVisibility: "public",
          seoAutopilotEnabled: true,
        },
        urls: ["/"],
      },
      {
        dryRun: false,
        fetchImpl: async () => {
          fetchCalls += 1;
          return new Response("OK", { status: 200 });
        },
      },
    );
    expect(fetchCalls).toBe(1);
    expect(mockRes.dispatched).toBe(true);
  });

  it("builds zero-config dashboard model, GBP + Bing Places copy card, and collapsed/hidden editor slot contract", async () => {
    const disabledSlot = resolveAutopilotEditorSlot({ seoAutopilotActive: false });
    expect(disabledSlot.mounted).toBe(false);
    expect(disabledSlot.visibleFieldCountWhenCollapsed).toBe(0);
    expect(disabledSlot.tabs).toHaveLength(0);

    const enabledSlot = resolveAutopilotEditorSlot({ seoAutopilotActive: true });
    expect(enabledSlot.mounted).toBe(true);
    expect(enabledSlot.collapsedByDefault).toBe(true);
    expect(enabledSlot.visibleFieldCountWhenCollapsed).toBe(0);
    expect(enabledSlot.tabs).toHaveLength(4);

    const dirCard = buildAutopilotDirectoryCopyCard({
      blueprintId: "b2b_corporate",
      businessName: "PT Nusantara Arsitek",
      primaryOrigin: "https://www.nusantara-arsitek.id",
      categoryLabel: "HomeAndConstructionBusiness",
      address: "Jl. Kemang Raya No. 18",
      city: "Jakarta Selatan",
      whatsappE164: "6281234567890",
    });
    expect(dirCard.callsExternalApi).toBe(false);
    expect(dirCard.platforms).toEqual(["Google Business Profile", "Bing Places"]);
    expect(dirCard.copyPlainText).toContain("Nama Bisnis: PT Nusantara Arsitek");
    expect(dirCard.copyPlainText).toContain("https://www.nusantara-arsitek.id");

    const model = await buildAutopilotPluginDashboardModel({
      tenantId: "01JT102TENANTA000000000001",
      handle: "nusantara-arsitek",
      businessName: "PT Nusantara Arsitek",
      primaryOrigin: "https://www.nusantara-arsitek.id",
      enabled: true,
      installed: true,
      aiTrainingPolicy: "disallow",
      indexnowEligibility: {
        tenantStatus: "active",
        primaryHost: "www.nusantara-arsitek.id",
        primaryHostKind: "custom",
        primaryHostStatus: "active",
        primaryHostSslStatus: "active",
        primaryHostVerified: true,
        siteVisibility: "public",
      },
      savedSettingsVersion: 2,
      hasSavedOverrides: true,
    });
    expect(model.zeroConfigRequired).toBe(true);
    expect(model.mandatoryFieldCount).toBe(0);
    expect(model.preservesOverridesOnDisable).toBe(true);
    expect(model.primaryActionLabel).toBe("Nonaktifkan");
    expect(model.sitemapUrl).toBe("https://www.nusantara-arsitek.id/sitemap.xml");
    expect(model.indexnow.eligible).toBe(true);
    expect(model.indexnow.keyLocation).toMatch(
      /^https:\/\/www\.nusantara-arsitek\.id\/[a-f0-9]{32}\.txt$/,
    );
    expect(model.aiBotSplit.searchAndAnswerBotCount).toBe(9);
    expect(model.aiBotSplit.trainingBotCount).toBe(4);
  });

  it("compiles real SEOHead.astro with seoAutopilotActive=false vs true via Astro SSR build and enforces zero Sparkles/Radix guardrails", async () => {
    // 1. Source hygiene checks (no Sparkles, no @radix-ui, no asChild)
    const pluginFiles = [
      "packages/plugins/seo-ai-autopilot/index.ts",
      "packages/plugins/seo-ai-autopilot/src/autopilot.ts",
      "packages/plugins/seo-ai-autopilot/src/discovery.ts",
      "packages/plugins/seo-ai-autopilot/src/dashboard.ts",
      "apps/web/src/components/SEOHead.astro",
    ];
    for (const rel of pluginFiles) {
      const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
      expect(src, `${rel} must not contain Sparkles`).not.toMatch(/\bSparkles(?:Icon)?\b/);
      expect(src, `${rel} must not import @radix-ui`).not.toContain("@radix-ui");
      expect(src, `${rel} must not use asChild`).not.toMatch(/\basChild\b/);
    }

    // 2. Real Astro SSR compilation of SEOHead.astro in disabled vs active modes
    const requireFromWeb = createRequire(path.join(WEB_DIR, "package.json"));
    const astroEntryUrl = pathToFileURL(requireFromWeb.resolve("astro")).href;
    const { build } = (await import(astroEntryUrl)) as {
      build: (config: Record<string, unknown>) => Promise<void>;
    };

    const astroWorkBase = path.join(WEB_DIR, ".astro");
    fs.mkdirSync(astroWorkBase, { recursive: true });
    const tmpRoot = fs.mkdtempSync(path.join(astroWorkBase, "t102-head-"));
    const pagesDir = path.join(tmpRoot, "src/pages");
    const outDir = path.join(tmpRoot, "dist");
    const cacheDir = path.join(tmpRoot, "cache");
    fs.mkdirSync(pagesDir, { recursive: true });

    const seoHeadImport = path.join(WEB_DIR, "src/components/SEOHead.astro");

    try {
      fs.writeFileSync(
        path.join(pagesDir, "head-disabled-trial.astro"),
        `---
import SEOHead from ${JSON.stringify(seoHeadImport)};
import { generateOpenGraphMetadata } from "@punyasitus/core/og-generator";
const metadata = generateOpenGraphMetadata({
  seo: {
    surface: "public_tenant",
    routeKind: "homepage",
    pathname: "/",
    tenant: {
      tenantHandle: "trial-demo",
      tenantStatus: "trial",
      primaryHost: "trial-demo.situsku.click",
      primaryHostKind: "subdomain",
      primaryHostStatus: "active",
      primaryHostSslStatus: "active",
      primaryHostVerified: true,
      verifiedTenantHosts: ["trial-demo.situsku.click"],
      servingHost: "trial-demo.situsku.click",
    },
  },
  siteName: "Trial Demo",
});
---
<html><head><SEOHead metadata={metadata} seoAutopilotActive={false} jsonLd={{ "@context": "https://schema.org", "@type": "WebSite" }} /></head><body>ok</body></html>`,
      );

      fs.writeFileSync(
        path.join(pagesDir, "head-active-paid.astro"),
        `---
import SEOHead from ${JSON.stringify(seoHeadImport)};
import { generateOpenGraphMetadata } from "@punyasitus/core/og-generator";
const metadata = generateOpenGraphMetadata({
  seo: {
    surface: "public_tenant",
    routeKind: "homepage",
    pathname: "/",
    tenant: {
      tenantHandle: "paid-demo",
      tenantStatus: "active",
      primaryHost: "www.paid-demo.id",
      primaryHostKind: "custom",
      primaryHostStatus: "active",
      primaryHostSslStatus: "active",
      primaryHostVerified: true,
      verifiedTenantHosts: ["www.paid-demo.id"],
      servingHost: "www.paid-demo.id",
    },
  },
  siteName: "Paid Demo",
  resourceExcerpt: "Solusi B2B resmi.",
});
---
<html><head><SEOHead metadata={metadata} seoAutopilotActive={true} jsonLd={{ "@context": "https://schema.org", "@type": "WebSite", name: "Paid Demo" }} blogEnabled={true} /></head><body>ok</body></html>`,
      );

      await build({
        root: tmpRoot,
        srcDir: path.join(tmpRoot, "src"),
        outDir,
        cacheDir,
        output: "static",
        logLevel: "silent",
      });

      const disabledHtml = fs.readFileSync(
        path.join(outDir, "head-disabled-trial/index.html"),
        "utf8",
      );
      expect(disabledHtml).toContain("<title>Trial Demo</title>");
      expect(disabledHtml).toContain('<meta name="robots" content="noindex, nofollow" />');
      expect(disabledHtml).not.toContain('type="application/ld+json"');
      expect(disabledHtml).not.toContain('property="og:title"');

      const activeHtml = fs.readFileSync(
        path.join(outDir, "head-active-paid/index.html"),
        "utf8",
      );
      expect(activeHtml).toContain("<title>Paid Demo</title>");
      expect(activeHtml).toContain('property="og:title"');
      expect(activeHtml).toContain('type="application/ld+json"');
      expect(activeHtml).toContain("https://www.paid-demo.id/blog/feed.xml");
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("fails CLOSED on TenantStore DB errors and supports HMAC-SHA-256 keyed IndexNow derivation consistently", async () => {
    const makeMockDb = (mode: "empty" | "enabled" | "disabled" | "throw"): D1Database =>
      ({
        prepare() {
          if (mode === "throw") {
            throw new Error("D1_DO_STORAGE_UNAVAILABLE");
          }
          return {
            bind() {
              return {
                async first() {
                  if (mode === "empty") return null;
                  return { enabled: mode === "enabled" ? 1 : 0 };
                },
              };
            },
          };
        },
      }) as unknown as D1Database;

    expect(await checkSeoAutopilotActiveInTenantDb(makeMockDb("empty"))).toEqual({
      ok: true,
      active: true,
      source: "default_provisioned",
    });
    expect(await checkSeoAutopilotActiveInTenantDb(makeMockDb("enabled"))).toEqual({
      ok: true,
      active: true,
      source: "installed_row",
    });
    expect(await checkSeoAutopilotActiveInTenantDb(makeMockDb("disabled"))).toEqual({
      ok: true,
      active: false,
      source: "installed_row",
    });

    // Throwing DB MUST fail CLOSED (`ok: false`, `active: false`)
    const errRes = await checkSeoAutopilotActiveInTenantDb(makeMockDb("throw"));
    expect(errRes.ok).toBe(false);
    expect(errRes.active).toBe(false);
    expect(await isSeoAutopilotActiveInTenantDb(makeMockDb("throw"))).toBe(false);

    // `resolveSeoAutopilotActiveFromLocals` enforces theme-layout automatic gating + fail-closed
    expect(
      await resolveSeoAutopilotActiveFromLocals({
        locals: { tenant: { id: "t1" }, tenantDb: makeMockDb("disabled") },
      }),
    ).toEqual({ active: false, dbError: false, source: "tenant_db" });
    expect(
      await resolveSeoAutopilotActiveFromLocals({
        locals: { tenant: { id: "t1" }, tenantDb: makeMockDb("throw") },
      }),
    ).toEqual({ active: false, dbError: true, source: "tenant_db_error_fail_closed" });
    expect(
      await resolveSeoAutopilotActiveFromLocals({
        locals: { tenant: { id: "t1" }, tenantDb: null },
      }),
    ).toEqual({ active: false, dbError: false, source: "tenant_without_db_fail_closed" });
    expect(await resolveSeoAutopilotActiveFromLocals({ locals: {} })).toEqual({
      active: true,
      dbError: false,
      source: "standalone_default",
    });

    // HMAC-SHA-256 keyed IndexNow derivation differs from unkeyed SHA-256 and from another secret
    const secretA = "worker-hmac-secret-alpha-2026";
    const secretB = "worker-hmac-secret-beta-2026";
    const unkeyed = await deriveDeterministicTenantIndexNowKey("01JT102TENANTA000000000001");
    const keyedA1 = await deriveDeterministicTenantIndexNowKey("01JT102TENANTA000000000001", {
      secret: secretA,
    });
    const keyedA2 = await deriveDeterministicTenantIndexNowKey("01JT102TENANTA000000000001", {
      secret: secretA,
    });
    const keyedB = await deriveDeterministicTenantIndexNowKey("01JT102TENANTA000000000001", {
      secret: secretB,
    });
    expect(keyedA1).toBe(keyedA2);
    expect(keyedA1).toMatch(/^[a-f0-9]{32}$/);
    expect(keyedA1).not.toBe(unkeyed);
    expect(keyedA1).not.toBe(keyedB);

    const elig = {
      tenantStatus: "active" as const,
      primaryHost: "www.nusantara-arsitek.id",
      primaryHostKind: "custom" as const,
      primaryHostStatus: "active" as const,
      primaryHostSslStatus: "active",
      primaryHostVerified: true,
      siteVisibility: "public" as const,
      seoAutopilotEnabled: true,
    };

    const verifiedKeyed = await verifyAutopilotIndexNowKeyFile({
      tenantId: "01JT102TENANTA000000000001",
      candidateKey: keyedA1,
      eligibility: elig,
      secret: secretA,
    });
    expect(verifiedKeyed.ok).toBe(true);

    const wrongUnkeyed = await verifyAutopilotIndexNowKeyFile({
      tenantId: "01JT102TENANTA000000000001",
      candidateKey: unkeyed,
      eligibility: elig,
      secret: secretA,
    });
    expect(wrongUnkeyed.ok).toBe(false);

    const pingKeyed = await buildAutopilotIndexNowPing({
      tenantId: "01JT102TENANTA000000000001",
      eligibility: elig,
      urls: ["/"],
      secret: secretA,
    });
    expect(pingKeyed.ready).toBe(true);
    if (pingKeyed.ready) {
      expect(pingKeyed.payload.key).toBe(keyedA1);
    }
  });

  it("enforces disabled & DB-error fail-closed SEOHead automatically in real compro Theme Layout without explicit seoAutopilotActive prop", async () => {
    const requireFromWeb = createRequire(path.join(WEB_DIR, "package.json"));
    const astroEntryUrl = pathToFileURL(requireFromWeb.resolve("astro")).href;
    const { build } = (await import(astroEntryUrl)) as {
      build: (config: Record<string, unknown>) => Promise<void>;
    };

    const astroWorkBase = path.join(WEB_DIR, ".astro");
    fs.mkdirSync(astroWorkBase, { recursive: true });
    const tmpRoot = fs.mkdtempSync(path.join(astroWorkBase, "t102-theme-"));
    const pagesDir = path.join(tmpRoot, "src/pages");
    const outDir = path.join(tmpRoot, "dist");
    const cacheDir = path.join(tmpRoot, "cache");
    fs.mkdirSync(pagesDir, { recursive: true });

    const comproLayoutImport = path.join(WEB_DIR, "src/themes/compro/Layout.astro");
    const publicDataImport = path.join(WEB_DIR, "src/core/public-data.ts");

    const buildContractSnippet = `
import { generateOpenGraphMetadata } from "@punyasitus/core/og-generator";
import { buildSafeThemeStyleBlock } from ${JSON.stringify(publicDataImport)};
const themeStyle = buildSafeThemeStyleBlock(null, "compro");
const makeContract = (tenantStatus: "active" | "trial" = "active") => {
  const metadata = generateOpenGraphMetadata({
    seo: {
      surface: "public_tenant",
      routeKind: "homepage",
      pathname: "/",
      tenant: {
        tenantHandle: "compro-demo",
        tenantStatus,
        primaryHost: tenantStatus === "trial" ? "compro-demo.punyasitus.id" : "www.compro-demo.id",
        primaryHostKind: tenantStatus === "trial" ? "subdomain" : "custom",
        primaryHostStatus: "active",
        primaryHostSslStatus: "active",
        primaryHostVerified: true,
        verifiedTenantHosts: [
          tenantStatus === "trial" ? "compro-demo.punyasitus.id" : "www.compro-demo.id",
        ],
        servingHost: tenantStatus === "trial" ? "compro-demo.punyasitus.id" : "www.compro-demo.id",
      },
    },
    siteName: "PT Compro Demo",
    resourceExcerpt: "Solusi manufaktur terpercaya.",
  });
  return {
    routeKind: "home",
    pathname: "/",
    seoMetadata: metadata,
    schemaGraph: { "@context": "https://schema.org", "@graph": [{ "@type": "WebSite", name: "PT Compro Demo" }] },
    headerCtaLabel: "Hubungi Kami",
    headerCtaHref: "#kontak",
    consent: {
      required: false,
      privacyPolicyUrl: "/kebijakan-privasi",
      vendorScripts: [],
      mapEmbed: undefined,
      initialCookieHeader: null,
    },
    shell: {
      isPreview: false,
      layoutMode: "standard",
      themeId: "compro",
      baseThemeId: "compro",
      themeStyle,
      site: {
        title: "PT Compro Demo",
        tagline: "Mitra B2B",
        locale: "id-ID",
        timezone: "Asia/Jakarta",
        siteVisibility: "public",
        blogEnabled: true,
        catalogEnabled: true,
        analyticsConfig: {},
      },
      business: {
        name: "PT Compro Demo",
        category: "b2b_corporate",
        description: "Mitra manufaktur",
        address: null,
        city: "Jakarta",
        province: null,
        postalCode: null,
        phone: null,
        whatsappE164: "6281234567890",
        email: null,
        mapsUrl: null,
        weekdayHours: "Senin-Jumat 08:00-17:00",
        holidayHours: null,
        socialLinks: {},
      },
      menus: { header: [], footer: [], mobile: [] },
      page: null,
      revisions: {
        siteSettingsVersion: 1,
        businessProfileVersion: 1,
        themeConfigVersion: 1,
        pageVersion: 1,
      },
    },
  };
};
`;

    try {
      // 1. Compro theme layout when Astro.locals.tenantDb reports seo-ai-autopilot DISABLED (enabled = 0)
      fs.writeFileSync(
        path.join(pagesDir, "compro-disabled.astro"),
        `---
import ComproLayout from ${JSON.stringify(comproLayoutImport)};
${buildContractSnippet}
const contract = makeContract("active");
Object.assign(Astro.locals, {
  tenant: { id: "tenant_compro_off" },
  tenantDb: {
    prepare() {
      return {
        bind() {
          return {
            async first() {
              return { enabled: 0 };
            },
          };
        },
      };
    },
  },
});
---
<ComproLayout contract={contract as never}><main>Konten</main></ComproLayout>`,
      );

      // 2. Compro theme layout on a TRIAL tenant when seo-ai-autopilot is DISABLED (safety noindex MUST remain!)
      fs.writeFileSync(
        path.join(pagesDir, "compro-disabled-trial.astro"),
        `---
import ComproLayout from ${JSON.stringify(comproLayoutImport)};
${buildContractSnippet}
const contract = makeContract("trial");
Object.assign(Astro.locals, {
  tenant: { id: "tenant_compro_trial_off" },
  tenantDb: {
    prepare() {
      return {
        bind() {
          return {
            async first() {
              return { enabled: 0 };
            },
          };
        },
      };
    },
  },
});
---
<ComproLayout contract={contract as never}><main>Konten</main></ComproLayout>`,
      );

      // 3. Compro theme layout when Astro.locals.tenantDb THROWS (must fail CLOSED!)
      fs.writeFileSync(
        path.join(pagesDir, "compro-db-error.astro"),
        `---
import ComproLayout from ${JSON.stringify(comproLayoutImport)};
${buildContractSnippet}
const contract = makeContract("active");
Object.assign(Astro.locals, {
  tenant: { id: "tenant_compro_err" },
  tenantDb: {
    prepare() {
      throw new Error("TENANT_STORE_FAILURE");
    },
  },
});
---
<ComproLayout contract={contract as never}><main>Konten</main></ComproLayout>`,
      );

      // 4. Compro theme layout when Astro.locals.tenantDb reports seo-ai-autopilot ENABLED (enabled = 1)
      fs.writeFileSync(
        path.join(pagesDir, "compro-enabled.astro"),
        `---
import ComproLayout from ${JSON.stringify(comproLayoutImport)};
${buildContractSnippet}
const contract = makeContract("active");
Object.assign(Astro.locals, {
  tenant: { id: "tenant_compro_on" },
  tenantDb: {
    prepare() {
      return {
        bind() {
          return {
            async first() {
              return { enabled: 1 };
            },
          };
        },
      };
    },
  },
});
---
<ComproLayout contract={contract as never}><main>Konten</main></ComproLayout>`,
      );

      await build({
        root: WEB_DIR,
        configFile: false,
        srcDir: path.join(tmpRoot, "src"),
        outDir,
        cacheDir,
        output: "static",
        devToolbar: { enabled: false },
        logLevel: "silent",
      });

      const disabledHtml = fs.readFileSync(
        path.join(outDir, "compro-disabled/index.html"),
        "utf8",
      );
      expect(disabledHtml).toContain("<title>PT Compro Demo</title>");
      expect(disabledHtml).not.toContain('property="og:title"');
      expect(disabledHtml).not.toContain('name="twitter:card"');
      expect(disabledHtml).not.toContain('type="application/ld+json"');

      const disabledTrialHtml = fs.readFileSync(
        path.join(outDir, "compro-disabled-trial/index.html"),
        "utf8",
      );
      expect(disabledTrialHtml).toContain("<title>PT Compro Demo</title>");
      expect(disabledTrialHtml).toContain('name="robots"');
      expect(disabledTrialHtml).toContain("noindex");
      expect(disabledTrialHtml).not.toContain('property="og:title"');
      expect(disabledTrialHtml).not.toContain('type="application/ld+json"');

      const dbErrHtml = fs.readFileSync(
        path.join(outDir, "compro-db-error/index.html"),
        "utf8",
      );
      expect(dbErrHtml).toContain("<title>PT Compro Demo</title>");
      expect(dbErrHtml).not.toContain('property="og:title"');
      expect(dbErrHtml).not.toContain('name="twitter:card"');
      expect(dbErrHtml).not.toContain('type="application/ld+json"');

      const enabledHtml = fs.readFileSync(
        path.join(outDir, "compro-enabled/index.html"),
        "utf8",
      );
      expect(enabledHtml).toContain("<title>PT Compro Demo</title>");
      expect(enabledHtml).toContain('property="og:title"');
      expect(enabledHtml).toContain('type="application/ld+json"');
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});

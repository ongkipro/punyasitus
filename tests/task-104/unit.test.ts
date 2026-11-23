import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import {
  assertHelpRegistryIntegrity,
  buildHelpArticleUrl,
  buildHelpOpenEventId,
  DASHBOARD_HELP_LINKS,
  DASHBOARD_HELP_SCREEN_IDS,
  filterHelpArticles,
  guardMarketingHelpHost,
  HELP_CATEGORIES,
  MIN_HELP_ARTICLE_COUNT,
  parseHelpArticleMarkdown,
  renderSafeHelpMarkdown,
  REQUIRED_HELP_LAUNCH_TOPICS,
  resolveDashboardHelpLink,
  sanitizeHelpOpenSource,
  validateHelpRegistryIntegrity,
  type HelpArticleRecord,
} from "@punyasitus/core/help/index";
import { MARKETING_JS_BUDGET_GZIP_BYTES } from "@punyasitus/core/marketing/index";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const CONTENT_DIR = path.join(REPO_ROOT, "apps/web/src/content/bantuan");
const HELP_PAGES_DIR = path.join(REPO_ROOT, "apps/web/src/pages/marketing/bantuan");
const ADMIN_HELP_DIR = path.join(REPO_ROOT, "apps/web/src/components/admin/help");
const CORE_HELP_DIR = path.join(REPO_ROOT, "packages/core/src/help");

function loadDiskHelpArticles(): HelpArticleRecord[] {
  const entries = fs
    .readdirSync(CONTENT_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .sort((a, b) => a.name.localeCompare(b.name));

  return entries.map((entry) => {
    const expectedSlug = entry.name.replace(/\.md$/i, "");
    const raw = fs.readFileSync(path.join(CONTENT_DIR, entry.name), "utf8");
    return parseHelpArticleMarkdown(raw, expectedSlug);
  });
}

describe("TASK-104 unit — Help Center content inventory & dashboard help_slug integrity", () => {
  it("ships at least 20 valid Indonesian help articles covering every required launch topic", () => {
    const articles = loadDiskHelpArticles();
    expect(articles.length).toBeGreaterThanOrEqual(MIN_HELP_ARTICLE_COUNT);

    const report = assertHelpRegistryIntegrity(articles, DASHBOARD_HELP_LINKS);
    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.articleCount).toBe(articles.length);
    expect(report.mappedScreenCount).toBe(DASHBOARD_HELP_SCREEN_IDS.length);

    for (const topic of REQUIRED_HELP_LAUNCH_TOPICS) {
      expect(report.coveredLaunchTopics).toContain(topic);
    }

    // Every category has at least 2 practical articles
    for (const cat of HELP_CATEGORIES) {
      const inCat = articles.filter((a) => a.category === cat.id);
      expect(inCat.length, `Category ${cat.id} should have articles`).toBeGreaterThanOrEqual(2);
    }
  });

  it("maps every dashboard screen to an existing help article and builds valid URLs", () => {
    const articles = loadDiskHelpArticles();
    const slugSet = new Set(articles.map((a) => a.slug));

    for (const screenId of DASHBOARD_HELP_SCREEN_IDS) {
      const link = resolveDashboardHelpLink(screenId);
      expect(slugSet.has(link.helpSlug), `Missing article for screen ${screenId}`).toBe(true);
      expect(link.href).toBe(
        `https://punyasitus.com/bantuan/${link.helpSlug}?from=dashboard`,
      );
      expect(link.indexHref).toBe("https://punyasitus.com/bantuan");
    }

    expect(
      buildHelpArticleUrl("menghubungkan-domain-kustom-dan-dns", {
        baseUrl: "/marketing/bantuan",
        from: "dashboard",
      }),
    ).toBe("/marketing/bantuan/menghubungkan-domain-kustom-dan-dns?from=dashboard");
  });

  it("FAILS integrity check loudly when ANY dashboard help_slug points to a missing article", () => {
    const articles = loadDiskHelpArticles();
    const brokenMap = {
      ...DASHBOARD_HELP_LINKS,
      broken_screen: { helpSlug: "artikel-yang-tidak-pernah-ada" },
    };

    const report = validateHelpRegistryIntegrity(articles, brokenMap);
    expect(report.ok).toBe(false);
    expect(report.errors).toContain(
      'Dashboard screen "broken_screen" maps to missing help_slug "artikel-yang-tidak-pernah-ada".',
    );
    expect(() => assertHelpRegistryIntegrity(articles, brokenMap)).toThrow(
      /artikel-yang-tidak-pernah-ada/,
    );
  });

  it("FAILS integrity check when fewer than 20 articles exist or relatedSlugs is broken", () => {
    const articles = loadDiskHelpArticles();
    const tooFew = articles.slice(0, 10);
    const fewReport = validateHelpRegistryIntegrity(tooFew, {});
    expect(fewReport.ok).toBe(false);
    expect(fewReport.errors.some((e) => e.includes("at least 20 articles"))).toBe(true);

    const withBrokenRelated: HelpArticleRecord[] = articles.map((article, idx) =>
      idx === 0 ? { ...article, relatedSlugs: ["slug-rusak-hilang"] } : article,
    );
    const relReport = validateHelpRegistryIntegrity(withBrokenRelated, DASHBOARD_HELP_LINKS);
    expect(relReport.ok).toBe(false);
    expect(relReport.errors.some((e) => e.includes("slug-rusak-hilang"))).toBe(true);
  });

  it("filters articles server-side by query and category without JavaScript", () => {
    const articles = loadDiskHelpArticles();
    const qrisMatches = filterHelpArticles(articles, { query: "QRIS" });
    expect(qrisMatches.length).toBeGreaterThanOrEqual(2);
    expect(qrisMatches.some((a) => a.slug === "membayar-langganan-qris-dan-virtual-account")).toBe(
      true,
    );

    const domainCat = filterHelpArticles(articles, { category: "domain" });
    expect(domainCat.length).toBeGreaterThanOrEqual(3);
    expect(domainCat.every((a) => a.category === "domain")).toBe(true);

    const empty = filterHelpArticles(articles, { query: "xyzzy-tidak-cocok-9999" });
    expect(empty).toEqual([]);
  });
});

describe("TASK-104 unit — XSS-safe Markdown renderer, host gating & privacy counter hygiene", () => {
  it("escapes raw HTML/scripts and blocks javascript:/data:/backslash protocol-relative links in Markdown", () => {
    const rendered = renderSafeHelpMarkdown(
      [
        "## Judul <script>alert(1)</script>",
        "",
        'Paragraf dengan <img src=x onerror=alert(2)> dan [klik bahaya](javascript:alert(3)), [slash-backslash](/\\evil.com), [double-slash](//evil.com) serta [tautan aman](https://punyasitus.com/bantuan).',
      ].join("\n"),
    );

    expect(rendered.html).not.toContain("<script>");
    expect(rendered.html).not.toContain("<img");
    expect(rendered.html).not.toContain("javascript:");
    expect(rendered.html).not.toContain("evil.com");
    expect(rendered.html).toContain("slash-backslash");
    expect(rendered.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(rendered.html).toContain('href="https://punyasitus.com/bantuan"');
    expect(rendered.headings).toHaveLength(1);
    expect(rendered.headings[0]?.id).toBe("judul-scriptalert1script");
  });

  it("enforces strict marketing-host gating (308 www -> apex /bantuan, neutral 404 on tenant/app/console hosts)", async () => {
    // 1. Canonical apex allowed (both /bantuan and rewritten /marketing/bantuan)
    expect(
      guardMarketingHelpHost(new Request("https://punyasitus.com/bantuan")),
    ).toBeNull();
    expect(
      guardMarketingHelpHost(new Request("https://punyasitus.com/marketing/bantuan")),
    ).toBeNull();

    // 2. www -> 308 permanent redirect to apex preserving /bantuan path & query with zero cookies
    const wwwBantuanRes = guardMarketingHelpHost(
      new Request("https://www.punyasitus.com/bantuan/memulai-uji-coba-dan-daftar-akun?from=dashboard"),
    );
    expect(wwwBantuanRes).not.toBeNull();
    expect(wwwBantuanRes!.status).toBe(308);
    expect(wwwBantuanRes!.headers.get("Location")).toBe(
      "https://punyasitus.com/bantuan/memulai-uji-coba-dan-daftar-akun?from=dashboard",
    );
    expect(wwwBantuanRes!.headers.get("set-cookie")).toBeNull();

    const wwwRes = guardMarketingHelpHost(
      new Request("https://www.punyasitus.com/marketing/bantuan/memulai-uji-coba-dan-daftar-akun?from=dashboard"),
    );
    expect(wwwRes).not.toBeNull();
    expect(wwwRes!.status).toBe(308);
    expect(wwwRes!.headers.get("Location")).toBe(
      "https://punyasitus.com/marketing/bantuan/memulai-uji-coba-dan-daftar-akun?from=dashboard",
    );
    expect(wwwRes!.headers.get("set-cookie")).toBeNull();

    // 3. Tenant hosts, app host, console host, and unknown hosts -> neutral 404
    for (const blockedUrl of [
      "https://toko-kopi.situsku.click/marketing/bantuan",
      "https://bisnis-klien.co.id/marketing/bantuan/memulai-uji-coba-dan-daftar-akun",
      "https://app.punyasitus.com/marketing/bantuan",
      "https://console.punyasitus.com/marketing/bantuan",
      "https://evil.example/marketing/bantuan",
    ]) {
      const blocked = guardMarketingHelpHost(new Request(blockedUrl));
      expect(blocked, `Expected 404 for ${blockedUrl}`).not.toBeNull();
      expect(blocked!.status).toBe(404);
      expect(blocked!.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
      expect(blocked!.headers.get("Cache-Control")).toBe("no-store");
      expect(blocked!.headers.get("Content-Security-Policy")).toBe("default-src 'none'");
      expect(blocked!.headers.get("set-cookie")).toBeNull();
      const body = await blocked!.text();
      expect(body).toContain("Halaman tidak ditemukan");
      expect(body).not.toContain("toko-kopi");
    }

    // 4. Local loopback allowed ONLY when appEnv is local/test
    const localReq = new Request("http://127.0.0.1:4321/marketing/bantuan");
    expect(guardMarketingHelpHost(localReq, { appEnv: "production" })?.status).toBe(404);
    expect(guardMarketingHelpHost(localReq, { appEnv: "local" })).toBeNull();
  });

  it("sanitizes open-counter sources to closed PII-free buckets and forbids runtime DDL", () => {
    expect(sanitizeHelpOpenSource("dashboard")).toBe("dashboard");
    expect(sanitizeHelpOpenSource("MARKETING")).toBe("marketing");
    expect(sanitizeHelpOpenSource("user@example.com")).toBe("direct");
    expect(sanitizeHelpOpenSource("6281234567890")).toBe("direct");
    expect(sanitizeHelpOpenSource(null)).toBe("direct");

    expect(
      buildHelpOpenEventId("2026-11-23", "memulai-uji-coba-dan-daftar-akun", "dashboard"),
    ).toBe("help_open:2026-11-23:memulai-uji-coba-dan-daftar-akun:dashboard");

    // Zero runtime DDL in core help & marketing bantuan routes
    for (const dir of [CORE_HELP_DIR, HELP_PAGES_DIR]) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const content = fs.readFileSync(path.join(dir, entry.name), "utf8");
        expect(content, `Forbidden CREATE TABLE in ${entry.name}`).not.toMatch(/CREATE\s+TABLE/i);
      }
    }
  });

  it("enforces zero client JS additions, zero admin CSS leakage, and zero third-party trackers on help routes", () => {
    const forbiddenOnHelpPages = [
      /@base-ui\/react/i,
      /@radix-ui\//i,
      /styles\/admin\/globals\.css/i,
      /document\.cookie/i,
      /googletagmanager\.com/i,
      /google-analytics\.com/i,
      /connect\.facebook\.net/i,
    ];

    let helpPageScriptSource = "";
    for (const entry of fs.readdirSync(HELP_PAGES_DIR, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const full = path.join(HELP_PAGES_DIR, entry.name);
      const content = fs.readFileSync(full, "utf8");
      for (const pattern of forbiddenOnHelpPages) {
        expect(content, `Forbidden ${pattern} in ${entry.name}`).not.toMatch(pattern);
      }
      if (entry.name.endsWith(".astro")) {
        const matches = content.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi);
        for (const m of matches) {
          if (/application\/ld\+json/i.test(m[0])) continue;
          helpPageScriptSource += m[1] ?? "";
        }
      }
    }

    // Zero client JS scripts added by help pages themselves!
    expect(helpPageScriptSource.trim()).toBe("");
    const gzipBytes = zlib.gzipSync(Buffer.from(helpPageScriptSource, "utf8")).byteLength;
    expect(gzipBytes).toBeLessThanOrEqual(MARKETING_JS_BUDGET_GZIP_BYTES);

    // Admin help component obeys DEC-036 (no Radix / no asChild)
    for (const entry of fs.readdirSync(ADMIN_HELP_DIR, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const content = fs.readFileSync(path.join(ADMIN_HELP_DIR, entry.name), "utf8");
      expect(content).not.toMatch(/@radix-ui\//);
      expect(content).not.toMatch(/\basChild\b/);
    }
  });
});

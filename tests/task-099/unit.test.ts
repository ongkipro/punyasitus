import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  measureEmittedPublicJsBytes,
  PUBLIC_PLUGIN_JS_BUDGET_BYTES,
  validatePluginManifest,
  validatePluginMigrationSql,
} from "@punyasitus/core/plugins/index";
import { serializeOpenApiDocument } from "@punyasitus/core/schemas";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ACTIVE_ON_PROVISION_PLUGIN_IDS,
  DEFAULT_PLUGIN_REGISTRY,
  REGISTERED_FIRST_PARTY_PLUGINS,
} from "../../apps/web/src/core/plugin-registry.ts";
import {
  BIO_LINKS_MANIFEST,
  BIO_LINKS_MIGRATIONS,
  BIO_LINKS_PLUGIN,
  BIO_LINKS_PLUGIN_ID,
  BioLinksConfigSchema,
  isNonCountingBioRequest,
  renderBioLinksPublicHtml,
  validateAvatarUrl,
  validateBioLinkCreateInput,
  validateBioLinkUrl,
} from "../../packages/plugins/bio-links/index.ts";
import {
  computeAttributionShares,
  isAgentOnShift,
  isNonCountingWaRequest,
  normalizeScheduleDays,
  renderWaRotatorCtaSectionHtml,
  renderWaRotatorHandoffHtml,
  resolveWhatsAppCtaWithRotator,
  sanitizeSourcePath,
  sanitizeWaItemTitle,
  selectAndRecordWaRotation,
  selectNextWaAgent,
  validateWaAgentInput,
  WA_CS_ROTATOR_MANIFEST,
  WA_CS_ROTATOR_MIGRATIONS,
  WA_CS_ROTATOR_PLUGIN,
  WA_CS_ROTATOR_PLUGIN_ID,
  WaCsRotatorConfigSchema,
  type WaRotatorAgentLike,
} from "../../packages/plugins/wa-cs-rotator/index.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

function makeAgent(
  overrides: Partial<WaRotatorAgentLike> & { readonly id: string; readonly name: string },
): WaRotatorAgentLike {
  return {
    roleLabel: "Sales CS",
    phoneE164: "6281234567890",
    weight: 1,
    scheduleDays: [1, 2, 3, 4, 5, 6],
    startTime: "08:00",
    endTime: "17:00",
    timezone: "Asia/Jakarta",
    isActive: true,
    sortOrder: 0,
    ...overrides,
  };
}

describe("TASK-099 Official Launch Seed Plugins (bio-links & wa-cs-rotator) — Unit & Invariant Tests", () => {
  it("statically registers bio-links and wa-cs-rotator without altering DEFAULT_ACTIVE_ON_PROVISION_PLUGIN_IDS", () => {
    expect(validatePluginManifest(BIO_LINKS_MANIFEST).id).toBe(BIO_LINKS_PLUGIN_ID);
    expect(validatePluginManifest(WA_CS_ROTATOR_MANIFEST).id).toBe(WA_CS_ROTATOR_PLUGIN_ID);

    expect(REGISTERED_FIRST_PARTY_PLUGINS).toContain(BIO_LINKS_PLUGIN);
    expect(REGISTERED_FIRST_PARTY_PLUGINS).toContain(WA_CS_ROTATOR_PLUGIN);

    expect(DEFAULT_PLUGIN_REGISTRY.has("bio-links")).toBe(true);
    expect(DEFAULT_PLUGIN_REGISTRY.has("wa-cs-rotator")).toBe(true);
    expect(DEFAULT_PLUGIN_REGISTRY.findByPublicRoute("/link")?.manifest.id).toBe("bio-links");
    expect(DEFAULT_PLUGIN_REGISTRY.findByPublicRoute("/link/go")?.manifest.id).toBe("bio-links");
    expect(DEFAULT_PLUGIN_REGISTRY.findByPublicRoute("/wa-rotator")?.manifest.id).toBe(
      "wa-cs-rotator",
    );
    expect(DEFAULT_PLUGIN_REGISTRY.findByPublicSection("wa-cs-rotator-cta")?.manifest.id).toBe(
      "wa-cs-rotator",
    );

    // Only seo-ai-autopilot is default active on provision (DEC-042)
    expect(DEFAULT_ACTIVE_ON_PROVISION_PLUGIN_IDS).toEqual(["seo-ai-autopilot"]);
  });

  it("validates all plugin migrations strictly under plg_bio_links__* and plg_wa_cs_rotator__*", () => {
    for (const mig of BIO_LINKS_MIGRATIONS) {
      const validated = validatePluginMigrationSql(BIO_LINKS_PLUGIN_ID, mig.sql);
      expect(validated.tablePrefix).toBe("plg_bio_links__");
      expect(validated.touchedObjects.every((t) => t.startsWith("plg_bio_links__"))).toBe(true);
    }

    for (const mig of WA_CS_ROTATOR_MIGRATIONS) {
      const validated = validatePluginMigrationSql(WA_CS_ROTATOR_PLUGIN_ID, mig.sql);
      expect(validated.tablePrefix).toBe("plg_wa_cs_rotator__");
      expect(validated.touchedObjects.every((t) => t.startsWith("plg_wa_cs_rotator__"))).toBe(true);
      expect(validated.touchedObjects).toContain("plg_wa_cs_rotator__agents");
    }
  });

  it("enforces zero edits to Frozen Core CMS packages, openapi.json drift-free, and base-nova UI hygiene", () => {
    // 1. Companion doc exists and openapi.json stays drift-free
    const docPath = path.join(REPO_ROOT, "docs/api/plugins-bio-rotator.md");
    expect(fs.existsSync(docPath)).toBe(true);
    const openApiPath = path.join(REPO_ROOT, "docs/api/openapi.json");
    expect(fs.readFileSync(openApiPath, "utf8")).toBe(serializeOpenApiDocument());

    // 2. Zero Frozen Core CMS edits in git status/diff
    const gitStatus = spawnSync("git", ["status", "--porcelain"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    expect(gitStatus.status).toBe(0);
    const changedPaths = gitStatus.stdout
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => line.slice(3).trim());

    const forbiddenPrefixes = [
      "packages/core/",
      "packages/db/",
      "packages/auth/",
      "apps/web/src/middleware/",
      "apps/web/src/pages/",
    ];
    for (const p of changedPaths) {
      for (const prefix of forbiddenPrefixes) {
        expect(p.startsWith(prefix), `Frozen Core file "${p}" must not be modified`).toBe(false);
      }
    }

    // 3. Zero Sparkles, zero @radix-ui/*, zero asChild in plugin admin UI files
    const uiFiles = [
      "packages/plugins/bio-links/src/admin/BioLinksAdminClient.tsx",
      "packages/plugins/wa-cs-rotator/src/admin/WaCsRotatorAdminClient.tsx",
    ];
    for (const rel of uiFiles) {
      const content = fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
      expect(content, `${rel} must not use Sparkles`).not.toMatch(/\bSparkles(?:Icon)?\b/);
      expect(content, `${rel} must not import @radix-ui`).not.toContain("@radix-ui/");
      expect(content, `${rel} must not use asChild`).not.toMatch(/\basChild\b/);
      expect(content, `${rel} must use explicit htmlFor bindings`).toContain("htmlFor=");
    }
  });

  describe("bio-links validation & zero-JS HTML rendering", () => {
    it("allows https:, http:, tel:, mailto:, and wa.me shorthand while rejecting XSS/unsafe schemes", () => {
      expect(validateBioLinkUrl("https://toko.id/katalog")).toMatchObject({
        ok: true,
        protocol: "https:",
      });
      expect(validateBioLinkUrl("http://toko.id/promo")).toMatchObject({
        ok: true,
        protocol: "http:",
      });
      expect(validateBioLinkUrl("tel:+6281234567890")).toMatchObject({
        ok: true,
        protocol: "tel:",
      });
      expect(validateBioLinkUrl("mailto:halo@toko.id")).toMatchObject({
        ok: true,
        protocol: "mailto:",
      });
      expect(validateBioLinkUrl("wa.me/6281234567890?text=Halo")).toMatchObject({
        ok: true,
        url: "https://wa.me/6281234567890?text=Halo",
        protocol: "https:",
      });

      const rejected = [
        "javascript:alert(1)",
        "JAVASCRIPT:alert(document.cookie)",
        "data:text/html,<script>alert(1)</script>",
        "vbscript:msgbox(1)",
        "file:///etc/passwd",
        "//evil.example/phish",
        "https://user:pass@evil.example/",
        "https://toko.id/\nSet-Cookie: x=1",
        "",
      ];
      for (const bad of rejected) {
        expect(validateBioLinkUrl(bad).ok, `Expected "${bad}" to be rejected`).toBe(false);
      }

      expect(() =>
        validateBioLinkCreateInput({ label: "XSS", url: "javascript:alert(1)" }),
      ).toThrow();
    });

    it("renders /link with strictly ZERO client JS bytes, escapes XSS payloads, and filters inactive links", () => {
      const rendered = renderBioLinksPublicHtml({
        tenant: {
          id: "ten_bio_1",
          handle: "budi-properti",
          name: "Budi <script>alert(1)</script>",
          status: "active",
          primaryHost: "budi-properti.situsku.click",
        },
        profile: {
          displayName: 'Budi "Santoso" <img src=x onerror=alert(1)>',
          headline: "Konsultan Properti Resmi",
          bioText: "Hubungi untuk daftar unit terbaru & simulasi KPR.",
          avatarUrl: "javascript:alert(1)", // Must be ignored at render time
          themeAccent: "#0F766E",
          whatsappPhone: "6281234567890",
          whatsappLabel: "Chat WhatsApp Budi",
          whatsappMessage: "Halo Budi, saya butuh brosur",
          showWhatsappButton: true,
          updatedAt: Date.now(),
        },
        items: [
          {
            id: "bl_active_1",
            label: "Katalog <b>Rumah</b>",
            url: "https://contoh.id/katalog",
            subtitle: "Update 2026",
            badge: "Baru",
            sortOrder: 0,
            isActive: true,
            clickCount: 5,
            createdAt: 1,
            updatedAt: 1,
          },
          {
            id: "bl_inactive_2",
            label: "Tautan Tersembunyi",
            url: "https://contoh.id/hidden",
            subtitle: "",
            badge: "",
            sortOrder: 1,
            isActive: false,
            clickCount: 0,
            createdAt: 2,
            updatedAt: 2,
          },
          {
            id: "bl_evil_3",
            label: "Tautan Berbahaya",
            url: "javascript:alert(99)",
            subtitle: "",
            badge: "",
            sortOrder: 2,
            isActive: true,
            clickCount: 0,
            createdAt: 3,
            updatedAt: 3,
          },
        ],
      });

      expect(rendered.jsBytes).toBe(0);
      expect(measureEmittedPublicJsBytes({ html: rendered.html, declaredJsBytes: 0 })).toBe(0);
      expect(rendered.html.toLowerCase()).not.toContain("<script");
      expect(rendered.html).not.toContain("javascript:");
      expect(rendered.html).not.toContain("<img src=x onerror=alert(1)>");
      expect(rendered.html).toContain("&lt;img src=x onerror=alert(1)&gt;");
      expect(rendered.html).toContain("/link/go?id=bl_active_1");
      expect(rendered.html).not.toContain("bl_inactive_2");
      expect(rendered.html).not.toContain("bl_evil_3");
      expect(rendered.html).toContain("https://wa.me/6281234567890");
    });

    it("validates BioLinksConfigSchema cleanly", () => {
      expect(
        BioLinksConfigSchema.safeParse({
          displayName: "Toko Jaya",
          themeAccent: "#0F766E",
          whatsappPhone: "0812-3456-7890",
          showWhatsappButton: true,
        }),
      ).toMatchObject({
        success: true,
        data: { whatsappPhone: "6281234567890", themeAccent: "#0F766E" },
      });

      expect(BioLinksConfigSchema.safeParse({ themeAccent: "red" }).success).toBe(false);
      expect(BioLinksConfigSchema.safeParse({ whatsappPhone: "+15551234567" }).success).toBe(false);
    });
  });

  describe("wa-cs-rotator distribution, schedules, fallback & instant revert", () => {
    // 2026-11-23 is a Monday (1). 03:00 UTC = 10:00 WIB (Asia/Jakarta, UTC+7)
    const MON_10_00_WIB = Date.UTC(2026, 10, 23, 3, 0, 0);
    // 2026-11-23 17:00 UTC = 2026-11-24 00:00 WIB (Tuesday 00:00 WIB)
    const TUE_00_00_WIB = Date.UTC(2026, 10, 23, 17, 0, 0);
    // 2026-11-23 16:00 UTC = 23:00 WIB (Monday night)
    const MON_23_00_WIB = Date.UTC(2026, 10, 23, 16, 0, 0);
    // 2026-11-22 03:00 UTC = Sunday 10:00 WIB
    const SUN_10_00_WIB = Date.UTC(2026, 10, 22, 3, 0, 0);

    it("evaluates active-hour schedules accurately across daytime, overnight, off-day, and WITA timezones", () => {
      const dayAgent = makeAgent({
        id: "agt_day",
        name: "Rina",
        scheduleDays: [1, 2, 3, 4, 5],
        startTime: "08:00",
        endTime: "17:00",
        timezone: "Asia/Jakarta",
      });
      const nightAgent = makeAgent({
        id: "agt_night",
        name: "Doni",
        scheduleDays: [1, 2, 3, 4, 5],
        startTime: "22:00",
        endTime: "06:00",
        timezone: "Asia/Jakarta",
      });
      const witaAgent = makeAgent({
        id: "agt_wita",
        name: "Sari",
        scheduleDays: [1],
        startTime: "10:30",
        endTime: "12:00",
        timezone: "Asia/Makassar", // UTC+8 -> MON_10_00_WIB is 11:00 WITA!
      });
      const pausedAgent = makeAgent({
        id: "agt_paused",
        name: "Off",
        isActive: false,
      });

      expect(isAgentOnShift(dayAgent, MON_10_00_WIB)).toBe(true);
      expect(isAgentOnShift(dayAgent, MON_23_00_WIB)).toBe(false);
      expect(isAgentOnShift(dayAgent, SUN_10_00_WIB)).toBe(false);

      expect(isAgentOnShift(nightAgent, MON_10_00_WIB)).toBe(false);
      expect(isAgentOnShift(nightAgent, MON_23_00_WIB)).toBe(true);
      expect(isAgentOnShift(nightAgent, TUE_00_00_WIB)).toBe(true); // Overnight spillover from Monday

      expect(isAgentOnShift(witaAgent, MON_10_00_WIB)).toBe(true);
      expect(isAgentOnShift(pausedAgent, MON_10_00_WIB)).toBe(false);
    });

    it("rotates cleanly in round_robin mode and skips off-shift/inactive agents", () => {
      const agents = [
        makeAgent({ id: "agt_1", name: "Andi", sortOrder: 0 }),
        makeAgent({ id: "agt_2", name: "Budi", sortOrder: 1 }),
        makeAgent({
          id: "agt_3_off",
          name: "Citra",
          sortOrder: 2,
          startTime: "18:00",
          endTime: "22:00",
        }),
        makeAgent({ id: "agt_4_paused", name: "Dedi", sortOrder: 3, isActive: false }),
      ];

      let state = { strategy: "round_robin" as const, cursorIndex: 0, weightedState: {} };
      const picked: string[] = [];
      for (let i = 0; i < 6; i += 1) {
        const dec = selectNextWaAgent({ agents, state, nowMs: MON_10_00_WIB });
        expect(dec.usedFallback).toBe(false);
        expect(dec.eligibleCount).toBe(2);
        picked.push(dec.selectedAgent!.id);
        state = {
          strategy: "round_robin",
          cursorIndex: dec.nextCursorIndex,
          weightedState: dec.nextWeightedState,
        };
      }

      expect(picked).toEqual(["agt_1", "agt_2", "agt_1", "agt_2", "agt_1", "agt_2"]);
    });

    it("distributes exact proportions using Smooth Weighted Round-Robin (SWRR)", () => {
      const agents = [
        makeAgent({ id: "agt_heavy", name: "Heavy", weight: 3, sortOrder: 0 }),
        makeAgent({ id: "agt_light", name: "Light", weight: 1, sortOrder: 1 }),
      ];

      let state: {
        strategy: "weighted";
        cursorIndex: number;
        weightedState: Readonly<Record<string, number>>;
      } = { strategy: "weighted", cursorIndex: 0, weightedState: {} };

      const sequence: string[] = [];
      for (let i = 0; i < 8; i += 1) {
        const dec = selectNextWaAgent({ agents, state, nowMs: MON_10_00_WIB });
        sequence.push(dec.selectedAgent!.id);
        state = {
          strategy: "weighted",
          cursorIndex: dec.nextCursorIndex,
          weightedState: dec.nextWeightedState,
        };
      }

      // Smooth distribution: never clumps all 3 heavy draws consecutively on every cycle
      expect(sequence.slice(0, 4)).toEqual(["agt_heavy", "agt_heavy", "agt_light", "agt_heavy"]);
      const heavyCount = sequence.filter((id) => id === "agt_heavy").length;
      const lightCount = sequence.filter((id) => id === "agt_light").length;
      expect(heavyCount).toBe(6);
      expect(lightCount).toBe(2);
    });

    it("signals fallback when all agents are off-shift and reverts instantly to single WA when disabled", async () => {
      const agents = [
        makeAgent({ id: "agt_day", name: "DayOnly", startTime: "08:00", endTime: "17:00" }),
      ];
      const offShiftDecision = selectNextWaAgent({
        agents,
        state: { strategy: "round_robin", cursorIndex: 0, weightedState: {} },
        nowMs: MON_23_00_WIB,
      });
      expect(offShiftDecision.usedFallback).toBe(true);
      expect(offShiftDecision.selectedAgent).toBeNull();

      // Instant revert to single-number base WA when disabled/unentitled (ZERO DB calls!)
      let dbTouched = false;
      const poisonDb = {
        pluginId: WA_CS_ROTATOR_PLUGIN_ID,
        tablePrefix: "plg_wa_cs_rotator__" as const,
        prepare() {
          dbTouched = true;
          throw new Error("DB must NEVER be queried when plugin is inactive!");
        },
        batch() {
          dbTouched = true;
          throw new Error("DB must NEVER be queried when plugin is inactive!");
        },
      };

      const reverted = await resolveWhatsAppCtaWithRotator({
        pluginActive: false,
        db: poisonDb,
        primaryWhatsappPhone: "0812-9999-8888",
        itemTitle: "Paket Jasa Konstruksi",
        pageUrl: "https://contoh.id/layanan/konstruksi",
      });
      expect(dbTouched).toBe(false);
      expect(reverted.mode).toBe("base_single_number");
      expect(reverted.rotated).toBe(false);
      expect(reverted.targetPhoneE164).toBe("6281299998888");
      expect(reverted.url).toContain("https://wa.me/6281299998888");
    });

    it("validates Indonesian E.164 phones, config schema, attribution shares, and <= 25 KiB public JS cap", () => {
      const valid = validateWaAgentInput({
        name: "Rina Wijaya",
        phone: "+62 813-4567-8901",
        weight: 5,
        scheduleDays: [1, 2, 3, 4, 5],
        startTime: "09:00",
        endTime: "18:00",
      });
      expect(valid.phoneE164).toBe("6281345678901");
      expect(valid.weight).toBe(5);

      expect(() =>
        validateWaAgentInput({ name: "Bad", phone: "+14155550199", weight: 1 }),
      ).toThrow();
      expect(() =>
        validateWaAgentInput({ name: "BadWeight", phone: "081234567890", weight: 0 }),
      ).toThrow();
      expect(() =>
        validateWaAgentInput({
          name: "BadTime",
          phone: "081234567890",
          startTime: "25:99",
        }),
      ).toThrow();

      expect(
        WaCsRotatorConfigSchema.safeParse({
          strategy: "weighted",
          fallbackWhatsappPhone: "0812-3456-7890",
          timezone: "Asia/Jakarta",
        }).success,
      ).toBe(true);
      expect(WaCsRotatorConfigSchema.safeParse({ strategy: "random" }).success).toBe(false);

      const shares = computeAttributionShares(
        [
          { ...makeAgent({ id: "a1", name: "A1" }), totalClicks: 6 },
          { ...makeAgent({ id: "a2", name: "A2" }), totalClicks: 2 },
        ],
        2,
        MON_10_00_WIB,
      );
      expect(shares.totalClicks).toBe(10);
      expect(shares.fallbackSharePercent).toBe(20);
      expect(shares.agents[0]?.sharePercent).toBe(60);

      // Verify public HTML emits 0 bytes JS (<= 25 KiB budget)
      const sec = renderWaRotatorCtaSectionHtml({
        tenant: { id: "t1", handle: "toko", name: "Toko", status: "active" },
        ctaLabel: "Chat Sales",
        onShiftCount: 2,
        href: "/wa-rotator",
      });
      const handoff = renderWaRotatorHandoffHtml({
        tenant: { id: "t1", handle: "toko", name: "Toko", status: "active" },
        ctaLabel: "Buka WA",
        result: {
          mode: "rotator",
          rotated: true,
          usedFallback: false,
          strategyUsed: "weighted",
          agent: { ...makeAgent({ id: "a1", name: "Rina" }), totalClicks: 1, createdAt: 1, updatedAt: 1 },
          targetPhoneE164: "6281234567890",
          url: "https://wa.me/6281234567890?text=Halo",
          message: "Halo",
          clickId: "clk_1",
        },
      });
      expect(measureEmittedPublicJsBytes({ html: sec.html, declaredJsBytes: sec.jsBytes })).toBe(0);
      expect(
        measureEmittedPublicJsBytes({ html: handoff.html, declaredJsBytes: handoff.jsBytes }),
      ).toBeLessThanOrEqual(PUBLIC_PLUGIN_JS_BUDGET_BYTES);
    });

    it("rejects backslash avatar paths (/\\evil.com), strips PII query/fragments from source_path, caps ?item=, rejects empty schedule segments, detects HEAD/prefetch, and retries CAS conflict", async () => {
      // 1. Backslash avatar path rejection in both validator and renderer
      expect(() => validateAvatarUrl("/\\evil.com/pwn.png")).toThrow();
      expect(validateAvatarUrl("/media/avatar.webp")).toBe("/media/avatar.webp");
      const renderedBadAvatar = renderBioLinksPublicHtml({
        tenant: { id: "t1", handle: "toko", name: "Toko", status: "active" },
        profile: {
          displayName: "Toko",
          headline: "",
          bioText: "",
          avatarUrl: "/\\evil.com/pwn.png",
          themeAccent: "#0F766E",
          whatsappPhone: "",
          whatsappLabel: "WA",
          whatsappMessage: "",
          showWhatsappButton: false,
          updatedAt: 1,
        },
        items: [],
      });
      expect(renderedBadAvatar.html).not.toContain("evil.com");
      expect(renderedBadAvatar.html).toContain("bio-monogram");

      // 2. Zero-PII source_path stripping (?email=...#hash removed)
      expect(
        sanitizeSourcePath("/produk/rumah-60?email=budi@contoh.id&token=secret123#section"),
      ).toBe("/produk/rumah-60");
      expect(sanitizeSourcePath("//evil.example/path")).toBe("/");

      // 3. ?item= capped at 120 chars & control chars stripped
      const longItem = `Promo\r\n\t\x00 ${"A".repeat(200)}`;
      const sanitizedItem = sanitizeWaItemTitle(longItem);
      expect(sanitizedItem).toBeDefined();
      expect(sanitizedItem!.length).toBeLessThanOrEqual(120);
      expect(sanitizedItem!).not.toMatch(/[\r\n\t\0]/);

      // 4. Empty schedule day segments rejected (never coerced to Sunday 0)
      expect(() => normalizeScheduleDays("1,,2")).toThrow();
      expect(() => normalizeScheduleDays(",1,2")).toThrow();
      expect(normalizeScheduleDays("1,2,5")).toEqual([1, 2, 5]);

      // 5. HEAD and prefetch/prerender detection
      expect(isNonCountingBioRequest(new Request("https://a.id/link/go?id=x", { method: "HEAD" }))).toBe(true);
      expect(
        isNonCountingBioRequest(
          new Request("https://a.id/link/go?id=x", { headers: { "Sec-Purpose": "prefetch" } }),
        ),
      ).toBe(true);
      expect(
        isNonCountingWaRequest(
          new Request("https://a.id/wa-rotator", { headers: { Purpose: "prefetch" } }),
        ),
      ).toBe(true);
      expect(
        isNonCountingWaRequest(
          new Request("https://a.id/wa-rotator", { headers: { "X-Moz": "prefetch" } }),
        ),
      ).toBe(true);
      expect(isNonCountingWaRequest(new Request("https://a.id/wa-rotator"))).toBe(false);

      // 6. Optimistic CAS retry test: first UPDATE returns changes=0 (concurrent writer bumped cursor & version),
      //    second attempt reads fresh cursor=1/version=1 and picks Agent B cleanly!
      let stateVersion = 0;
      let cursorIndex = 0;
      let casAttempts = 0;
      const batchCalls: string[] = [];

      const mockAgents = [
        {
          id: "agt_a",
          name: "Agent A",
          role_label: "Sales",
          phone_e164: "6281211111111",
          weight: 1,
          schedule_days: "0,1,2,3,4,5,6",
          start_time: "00:00",
          end_time: "24:00",
          timezone: "Asia/Jakarta",
          is_active: 1,
          sort_order: 0,
          total_clicks: 0,
          created_at: 1,
          updated_at: 1,
        },
        {
          id: "agt_b",
          name: "Agent B",
          role_label: "Sales",
          phone_e164: "6281222222222",
          weight: 1,
          schedule_days: "0,1,2,3,4,5,6",
          start_time: "00:00",
          end_time: "24:00",
          timezone: "Asia/Jakarta",
          is_active: 1,
          sort_order: 1,
          total_clicks: 0,
          created_at: 2,
          updated_at: 2,
        },
      ];

      const mockDb = {
        pluginId: WA_CS_ROTATOR_PLUGIN_ID,
        tablePrefix: "plg_wa_cs_rotator__" as const,
        prepare(sql: string) {
          const boundArgs: unknown[] = [];
          const stmt = {
            bind(...args: unknown[]) {
              boundArgs.push(...args);
              return stmt;
            },
            async all() {
              if (sql.includes("FROM plg_wa_cs_rotator__agents")) {
                return { results: mockAgents, success: true, meta: {} };
              }
              return { results: [], success: true, meta: {} };
            },
            async first() {
              if (sql.includes("FROM plg_wa_cs_rotator__state")) {
                return {
                  strategy: "round_robin",
                  cursor_index: cursorIndex,
                  weighted_state_json: "{}",
                  fallback_whatsapp_phone: "",
                  timezone: "Asia/Jakarta",
                  fallback_clicks: 0,
                  last_agent_id: null,
                  state_version: stateVersion,
                  updated_at: 1000,
                };
              }
              return null;
            },
            async run() {
              if (sql.includes("UPDATE plg_wa_cs_rotator__state")) {
                casAttempts += 1;
                if (casAttempts === 1) {
                  // Simulate concurrent writer winning first: cursor & version advance!
                  cursorIndex = 1;
                  stateVersion = 1;
                  return { success: true, meta: { changes: 0 } };
                }
                const expectedVersion = boundArgs[boundArgs.length - 1];
                if (expectedVersion === stateVersion) {
                  cursorIndex = Number(boundArgs[1]);
                  stateVersion += 1;
                  return { success: true, meta: { changes: 1 } };
                }
                return { success: true, meta: { changes: 0 } };
              }
              return { success: true, meta: { changes: 1 } };
            },
          };
          return stmt as unknown as D1PreparedStatement;
        },
        async batch<T = Record<string, unknown>>(
          stmts: D1PreparedStatement[],
        ): Promise<D1Result<T>[]> {
          batchCalls.push(`batch:${stmts.length}`);
          return [] as D1Result<T>[];
        },
      };

      const res = await selectAndRecordWaRotation({
        db: mockDb,
        primaryWhatsappPhone: "6281100001111",
        nowMs: MON_10_00_WIB,
      });
      expect(casAttempts).toBe(2);
      expect(res.agent?.id).toBe("agt_b"); // Retried cleanly onto Agent B instead of duplicating Agent A!
      expect(cursorIndex).toBe(2);
      expect(stateVersion).toBe(2);
      expect(batchCalls.length).toBe(1); // Click batch committed ONLY once after CAS won!
    });

    it("exercises publicSlots.routes['/wa-rotator'] directly when all agents are off-shift across persisted fallback, tenant.whatsappE164, and unconfigured safe card", async () => {
      const routeHandler = WA_CS_ROTATOR_PLUGIN.publicSlots!.routes!["/wa-rotator"]!;
      const offShiftAgentRow = {
        id: "agt_day_only",
        name: "Rina Pagi",
        role_label: "Sales",
        phone_e164: "6281211111111",
        weight: 1,
        schedule_days: "1,2,3,4,5",
        start_time: "08:00",
        end_time: "17:00",
        timezone: "Asia/Jakarta",
        is_active: 1,
        sort_order: 0,
        total_clicks: 0,
        created_at: 1,
        updated_at: 1,
      };

      const makeStatefulMockDb = (initialFallbackPhone: string) => {
        let fallbackClicks = 0;
        let stateVersion = 1;
        const db = {
          pluginId: WA_CS_ROTATOR_PLUGIN_ID,
          tablePrefix: "plg_wa_cs_rotator__" as const,
          prepare(sql: string) {
            const stmt = {
              bind() {
                return stmt;
              },
              async all() {
                if (sql.includes("FROM plg_wa_cs_rotator__agents")) {
                  return { results: [offShiftAgentRow], success: true, meta: {} };
                }
                return { results: [], success: true, meta: {} };
              },
              async first() {
                if (sql.includes("FROM plg_wa_cs_rotator__state")) {
                  return {
                    strategy: "round_robin",
                    cursor_index: 0,
                    weighted_state_json: "{}",
                    fallback_whatsapp_phone: initialFallbackPhone,
                    timezone: "Asia/Jakarta",
                    fallback_clicks: fallbackClicks,
                    last_agent_id: null,
                    state_version: stateVersion,
                    updated_at: 1000,
                  };
                }
                return null;
              },
              async run() {
                if (sql.includes("UPDATE plg_wa_cs_rotator__state")) {
                  fallbackClicks += 1;
                  stateVersion += 1;
                  return { success: true, meta: { changes: 1 } };
                }
                return { success: true, meta: { changes: 1 } };
              },
            };
            return stmt as unknown as D1PreparedStatement;
          },
          async batch<T = Record<string, unknown>>(): Promise<D1Result<T>[]> {
            return [] as D1Result<T>[];
          },
        };
        return { db, getFallbackClicks: () => fallbackClicks };
      };

      // (a) Persisted fallbackWhatsappPhone in state (empty config) -> wa.me handoff + fallback click incremented
      const mockA = makeStatefulMockDb("6281100001111");
      const resA = await routeHandler({
        tenant: { id: "t1", handle: "toko", name: "Toko Jaya", status: "active" },
        request: new Request("https://toko.situsku.click/wa-rotator"),
        pathname: "/wa-rotator",
        config: {},
        db: mockA.db,
        nowMs: MON_23_00_WIB,
      } as Parameters<typeof routeHandler>[0]);
      expect(resA.status).toBe(200);
      expect(resA.jsBytes).toBe(0);
      expect(resA.html).toContain("https://wa.me/6281100001111");
      expect(resA.html).toContain('data-mode="rotator_fallback"');
      expect(mockA.getFallbackClicks()).toBe(1);

      // (b) Extended tenant.whatsappE164 (empty state & config fallback) -> wa.me handoff to tenant's primary WA
      const mockB = makeStatefulMockDb("");
      const resB = await routeHandler({
        tenant: {
          id: "t1",
          handle: "toko",
          name: "Toko Jaya",
          status: "active",
          whatsappE164: "628199998888",
        } as Parameters<typeof routeHandler>[0]["tenant"],
        request: new Request("https://toko.situsku.click/wa-rotator"),
        pathname: "/wa-rotator",
        config: {},
        db: mockB.db,
        nowMs: MON_23_00_WIB,
      } as Parameters<typeof routeHandler>[0]);
      expect(resB.status).toBe(200);
      expect(resB.jsBytes).toBe(0);
      expect(resB.html).toContain("https://wa.me/628199998888");
      expect(mockB.getFallbackClicks()).toBe(1);

      // (c) Neither configured -> safe 200 unavailable card with link back to `/` and 0 JS bytes
      const mockC = makeStatefulMockDb("");
      const resC = await routeHandler({
        tenant: { id: "t1", handle: "toko", name: "Toko Jaya", status: "active" },
        request: new Request("https://toko.situsku.click/wa-rotator"),
        pathname: "/wa-rotator",
        config: {},
        db: mockC.db,
        nowMs: MON_23_00_WIB,
      } as Parameters<typeof routeHandler>[0]);
      expect(resC.status).toBe(200);
      expect(resC.jsBytes).toBe(0);
      expect(measureEmittedPublicJsBytes({ html: resC.html, declaredJsBytes: resC.jsBytes })).toBe(0);
      expect(resC.html).toContain("wa-rotator-unavailable");
      expect(resC.html).toContain('href="/"');
      expect(resC.html).toContain("Kembali ke Situs Utama");
    });
  });
});

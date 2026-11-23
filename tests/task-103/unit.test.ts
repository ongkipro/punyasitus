import fs from "node:fs";
import path from "node:path";
import {
  buildOwnerSafeHeldPublishNotice,
  computeScreeningContentHash,
  CONTENT_TRUNCATION_HOLD_RULE_ID,
  DEFAULT_CONTENT_SCREENING_RULES,
  extractPublishContent,
  HELD_FOR_REVIEW_REASON_CODE,
  hostMatchesDenylistedDomain,
  mergeScreeningRules,
  normalizeForScreening,
  normalizeScreeningHost,
  OWNER_HELD_FOR_REVIEW_NOTICE,
  sanitizeFindingExcerpt,
  screenPublishContent,
  validateScreeningRuleInput,
} from "@punyasitus/core/content-screening/index";
import {
  PLATFORM_0025_SHARED_DOMAIN_PROTECTION_SQL,
  SHARED_DOMAIN_PROTECTION_MIGRATION,
  TENANT_0019_CONTENT_SCREENING_HOLDS_SQL,
  TENANT_CONTENT_SCREENING_HOLDS_MIGRATION,
} from "@punyasitus/db/content-screening/index";
import { PLATFORM_MIGRATIONS } from "@punyasitus/db/platform";
import { TENANT_MIGRATIONS } from "@punyasitus/db/tenant";
import { describe, expect, it } from "vitest";
import {
  formatWibDateDay,
  isValidIpv4,
  parseTrustPositifIpList,
} from "../../apps/web/src/worker/cron/trust-watch.ts";

const ROOT = path.resolve(import.meta.dirname, "../..");

describe("TASK-103 unit — Publish Screening Engine, Trust+ Parser, Migrations, Fallback Zone & UI Hygiene", () => {
  it("keeps bundled migration SQL byte-for-byte identical to SQL files without mutating 0001 checksums", () => {
    const platformSql = fs.readFileSync(
      path.join(ROOT, "packages/db/migrations/platform/0025_shared_domain_protection.sql"),
      "utf8",
    );
    const tenantSql = fs.readFileSync(
      path.join(ROOT, "packages/db/migrations/tenant/0019_content_screening_holds.sql"),
      "utf8",
    );

    expect(PLATFORM_0025_SHARED_DOMAIN_PROTECTION_SQL).toBe(platformSql);
    expect(platformSql).toContain("ON content_screening_reviews(tenant_id, idempotency_key)");
    expect(platformSql).toContain("content_screening_reviews_open_dedup_idx");
    expect(SHARED_DOMAIN_PROTECTION_MIGRATION.version).toBe(25);
    expect(SHARED_DOMAIN_PROTECTION_MIGRATION.name).toBe("0025_shared_domain_protection");

    expect(TENANT_0019_CONTENT_SCREENING_HOLDS_SQL).toBe(tenantSql);
    expect(TENANT_CONTENT_SCREENING_HOLDS_MIGRATION.version).toBe(19);
    expect(TENANT_CONTENT_SCREENING_HOLDS_MIGRATION.name).toBe("0019_content_screening_holds");

    // Preserve TASK-001 initial migration descriptors untouched
    expect(PLATFORM_MIGRATIONS.length).toBe(1);
    expect(PLATFORM_MIGRATIONS[0]?.name).toBe("0001_initial_platform");
    expect(TENANT_MIGRATIONS[0]?.name).toBe("0001_initial_tenant");
  });

  it("normalizes NFKC fullwidth, Cyrillic/Greek homoglyphs, leetspeak, zero-width chars, and separator evasion in O(N) time", () => {
    // Fullwidth + zero-width characters
    const fullwidth = screenPublishContent({
      title: "Promo ｓｌｏｔ\u200b ｇａｃｏｒ Hari Ini",
    });
    expect(fullwidth.verdict).toBe("hold_for_review");
    expect(fullwidth.matchedCategories).toContain("gambling");

    // Cyrillic homoglyphs (о, а, с)
    const homoglyph = screenPublishContent({
      text: "Daftar sl\u043et g\u0430\u0441\u043er resmi terpercaya",
    });
    expect(homoglyph.verdict).toBe("hold_for_review");

    // Leetspeak evasion (BOTH 1/| -> i AND 1/| -> l!)
    const leet = screenPublishContent({
      text: "Link 5l0t g@c0r m@xw1n malam ini",
    });
    expect(leet.verdict).toBe("hold_for_review");

    const leetL1 = screenPublishContent({ text: "Promo s1ot gac0r malam ini" });
    expect(leetL1.verdict).toBe("hold_for_review");

    const leetPipe = screenPublishContent({ text: "Promo s|ot gac0r malam ini" });
    expect(leetPipe.verdict).toBe("hold_for_review");

    // Short keyword punctuation/separator evasion (`j.u.d.o.l`, `j·udol`, `j u d o l`)
    for (const hostile of [
      "Daftar j.u.d.o.l hari ini",
      "Info j\u00b7udol resmi",
      "Akses j u d o l cepat",
      "Promo s\u3164lot gacor terbaru",
      "Promo s\u2800lot gacor terbaru",
      "Promo s\uFE0Flot gacor terbaru",
      "Promo s\u{E0001}lot gacor terbaru",
    ]) {
      const res = screenPublishContent({ text: hostile });
      expect(res.verdict, `Expected hostile evasion "${hostile}" to be held`).toBe(
        "hold_for_review",
      );
      expect(res.matchedCategories).toContain("gambling");
    }

    // Punctuation/separator obfuscation
    const separated = screenPublishContent({
      text: "Akses s.l.o.t-g.a.c.o.r dan j.u.d.i-o.n.l.i.n.e terbaru",
    });
    expect(separated.verdict).toBe("hold_for_review");

    // Fail-closed truncation check on 180k-char adversarial padding payload (defeats padding bypass!)
    const start = performance.now();
    const huge = "a ".repeat(90_000) + "slot gacor";
    const bounded = screenPublishContent({ text: huge });
    const elapsedMs = performance.now() - start;
    expect(bounded.truncated).toBe(true);
    expect(bounded.verdict).toBe("hold_for_review");
    expect(bounded.findings.some((f) => f.ruleId === CONTENT_TRUNCATION_HOLD_RULE_ID)).toBe(true);
    expect(elapsedMs).toBeLessThan(250);

    // Linear O(N) anti-ReDoS test on pathological hyphen chain ("a-".repeat(25000) + " x.y")
    const redosStart = performance.now();
    const redosPayload = `${"a-".repeat(25_000)} x.y`;
    const redosRes = screenPublishContent({ text: redosPayload });
    const redosElapsedMs = performance.now() - redosStart;
    expect(redosElapsedMs).toBeLessThan(200);
    expect(redosRes.truncated).toBe(true);
    expect(redosRes.verdict).toBe("hold_for_review");

    // Non-whitespace-prefixed protocol-relative `x//slotgacor.example` MUST still be extracted!
    const prefixedProtoRel = screenPublishContent({
      title: "Tautan",
      text: "Cek x//slotgacor.example sekarang",
    });
    expect(prefixedProtoRel.verdict).toBe("hold_for_review");
    expect(prefixedProtoRel.matchedFields).toContain("link_host");
    expect(
      prefixedProtoRel.findings.some((f) => f.matchedHost === "slotgacor.example"),
    ).toBe(true);

    const forms = normalizeForScreening("Sl\u043et\u200B 88!");
    expect(forms.canonical).toContain("slot 88");
  });

  it("screens titles, rich text, resolved link hosts (incl. subdomains), hidden image ALTs, and custom-form labels", () => {
    // Denylisted link host (subdomain match, protocol-relative //host, and bare domain in prose)
    const linkMatch = screenPublishContent({
      title: "Artikel Edukasi",
      text: 'Kunjungi <a href="https://promo.slotgacor.example/bonus?ref=1">halaman promo</a>.',
    });
    expect(linkMatch.verdict).toBe("hold_for_review");
    expect(linkMatch.matchedFields).toContain("link_host");
    expect(linkMatch.findings.some((f) => f.matchedHost === "promo.slotgacor.example")).toBe(true);

    const protoRelMatch = screenPublishContent({
      title: "Promo Mitra",
      text: 'Klik <a href="//vip.slotgacor.example/masuk">portal</a> atau //slot88.example/daftar',
    });
    expect(protoRelMatch.verdict).toBe("hold_for_review");
    expect(protoRelMatch.matchedFields).toContain("link_host");
    expect(protoRelMatch.findings.some((f) => f.matchedHost === "vip.slotgacor.example")).toBe(true);

    const bareDomainMatch = screenPublishContent({
      title: "Info Komunitas",
      text: "Silakan buka slotgacor.example untuk informasi lengkap.",
    });
    expect(bareDomainMatch.verdict).toBe("hold_for_review");
    expect(bareDomainMatch.matchedFields).toContain("link_host");
    expect(bareDomainMatch.findings.some((f) => f.matchedHost === "slotgacor.example")).toBe(true);

    expect(normalizeScreeningHost("//promo.slotgacor.example/path")).toBe("promo.slotgacor.example");

    // Hidden HTML <img alt="..."> and Markdown ![alt](...)
    const hiddenAlt = screenPublishContent({
      title: "Profil Perusahaan Bersih",
      text: '<div class="sr-only"><img src="/pixel.gif" alt="daftar judi online sbobet" /></div>',
    });
    expect(hiddenAlt.verdict).toBe("hold_for_review");
    expect(hiddenAlt.matchedFields).toContain("image_alt");

    // Custom form labels
    const formLabel = screenPublishContent({
      title: "Formulir Pendaftaran",
      isFormResource: true,
      snapshot: {
        fields: [
          { id: "f1", label: "Nama Lengkap" },
          { id: "f2", label: "Masukkan PIN ATM untuk verifikasi cepat" },
        ],
      },
    });
    expect(formLabel.verdict).toBe("hold_for_review");
    expect(formLabel.matchedCategories).toContain("phishing");
    expect(formLabel.matchedFields).toContain("form_label");

    // Malware APK & financial scam patterns
    const malware = screenPublishContent({
      text: "Silakan unduh apk undangan nikah terbaru dari tautan berikut.",
    });
    expect(malware.verdict).toBe("hold_for_review");
    expect(malware.matchedCategories).toContain("malware");

    const scam = screenPublishContent({
      text: "Program titip dana profit pasti mingguan tanpa risiko.",
    });
    expect(scam.verdict).toBe("hold_for_review");
    expect(scam.matchedCategories).toContain("scam");

    expect(normalizeScreeningHost("HTTPS://Sub.SlotGacor.Example:8443/path")).toBe(
      "sub.slotgacor.example",
    );
    expect(hostMatchesDenylistedDomain("promo.slotgacor.example", "slotgacor.example")).toBe(true);
    expect(hostMatchesDenylistedDomain("bukan-slotgacor.example", "slotgacor.example")).toBe(false);
  });

  it("allows clean Indonesian SME business content with zero false positives", () => {
    const cleanPayloads = [
      {
        title: "Katering Nusantara Jakarta — Paket Nasi Box & Prasmanan Halal",
        text: "Kami melayani katering kantor, acara pernikahan, dan syukuran sejak 2018. Hubungi WhatsApp kami untuk daftar menu terbaru.",
        links: ["https://wa.me/6281234567890", "https://maps.google.com/?q=Jakarta"],
        imageAlts: ["Prasmanan katering halal Jakarta Selatan"],
      },
      {
        title: "Klinik Gigi Sehat Bersama — Dokter Gigi Spesialis Konservasi",
        text: "Jadwal praktek Senin–Sabtu pukul 09.00–20.00 WIB. Tersedia slot konsultasi pagi dan sore untuk perawatan karang gigi dan tambal estetik.",
        formLabels: ["Nama Pasien", "Nomor WhatsApp", "Pilih Slot Waktu Kunjungan"],
      },
      {
        title: "Travel Umrah Berizin Resmi Kemenag — Paket 9 Hari Hotel Dekat Masjidil Haram",
        text: "Penerbangan langsung Jakarta–Jeddah, bimbingan manasik lengkap, dan transparansi biaya paket.",
      },
    ];

    for (const payload of cleanPayloads) {
      const res = screenPublishContent(payload);
      expect(res.verdict, `Expected clean payload "${payload.title}" to pass`).toBe("allow");
      expect(res.findings).toEqual([]);
      expect(res.reasonCode).toBeNull();
      expect(res.ownerNotice).toBeNull();
    }
  });

  it("scrubs secrets and PII from operator findings and hides matched terms from owner-facing notices", async () => {
    const res = screenPublishContent({
      text: "Daftar slot gacor hubungi budi@rahasia.id atau 081234567890 dengan Bearer sk_live_secret1234567890",
    });
    expect(res.verdict).toBe("hold_for_review");
    expect(res.findings.length).toBeGreaterThan(0);
    for (const f of res.findings) {
      expect(f.redactedExcerpt).not.toContain("budi@rahasia.id");
      expect(f.redactedExcerpt).not.toContain("081234567890");
      expect(f.redactedExcerpt).not.toContain("sk_live_secret1234567890");
    }

    const sanitized = sanitizeFindingExcerpt("token=abc123456789 email admin@toko.id +6281399887766");
    expect(sanitized).not.toContain("abc123456789");
    expect(sanitized).not.toContain("admin@toko.id");
    expect(sanitized).not.toContain("81399887766");

    const ownerNotice = buildOwnerSafeHeldPublishNotice("01J103REVIEW00000000000001");
    expect(ownerNotice).toEqual({
      held: true,
      status: "draft",
      reason: HELD_FOR_REVIEW_REASON_CODE,
      reviewId: "01J103REVIEW00000000000001",
      message: OWNER_HELD_FOR_REVIEW_NOTICE,
    });
    expect(JSON.stringify(ownerNotice)).not.toContain("slot gacor");

    const hashA = await computeScreeningContentHash({ title: "Halo", slug: "halo" });
    const hashB = await computeScreeningContentHash({ title: "Halo", slug: "halo" });
    expect(hashA).toBe(hashB);
    expect(hashA).toMatch(/^[a-f0-9]{64}$/);
  });

  it("validates operator screening rules and merges overrides cleanly", () => {
    const validDom = validateScreeningRuleInput({
      ruleType: "domain",
      pattern: "https://Promo.JudiBaru.Example/daftar",
      category: "gambling",
      severity: "high",
    });
    expect(validDom.ok).toBe(true);
    if (validDom.ok) {
      expect(validDom.data.pattern).toBe("promo.judibaru.example");
    }

    const badKw = validateScreeningRuleInput({
      ruleType: "keyword",
      pattern: "ab",
      category: "gambling",
    });
    expect(badKw.ok).toBe(false);

    const merged = mergeScreeningRules(
      [
        {
          id: "op-disable-sbobet",
          ruleType: "keyword",
          pattern: "sbobet",
          category: "gambling",
          severity: "high",
          active: false,
          ruleVersion: 2,
          source: "operator",
        },
        {
          id: "op-add-custom",
          ruleType: "keyword",
          pattern: "jackpot sensasional",
          category: "gambling",
          severity: "high",
          active: true,
          ruleVersion: 3,
          source: "operator",
        },
      ],
      DEFAULT_CONTENT_SCREENING_RULES,
    );
    expect(merged.rulesetVersion).toBe(3);
    expect(merged.rules.some((r) => r.pattern === "sbobet")).toBe(false);
    expect(merged.rules.some((r) => r.pattern === "jackpot sensasional")).toBe(true);
  });

  it("parses Komdigi Trust+ IPv4 lists strictly and formats WIB dates accurately", () => {
    expect(isValidIpv4("104.21.10.5")).toBe(true);
    expect(isValidIpv4("256.1.1.1")).toBe(false);
    expect(isValidIpv4("01.2.3.4")).toBe(false);
    expect(isValidIpv4("2001:db8::1")).toBe(false);

    const parsed = parseTrustPositifIpList(`
      # Komdigi Trust+ IPv4 fixture
      198.51.100.42
      203.0.113.99  # trailing note
      invalid-entry
      999.0.0.1
      198.51.100.42
    `);
    expect(parsed.size).toBe(2);
    expect(parsed.has("198.51.100.42")).toBe(true);
    expect(parsed.has("203.0.113.99")).toBe(true);

    // 2026-11-23T18:30:00Z = 2026-11-24T01:30:00+07:00 (next calendar day in WIB)
    expect(formatWibDateDay(Date.parse("2026-11-23T18:30:00Z"))).toBe("2026-11-24");
  });

  it("documents the standby second tenant zone in infra/cloudflare and normalisation runbook in docs/operations/trust-positif.md", () => {
    const topology = JSON.parse(
      fs.readFileSync(path.join(ROOT, "infra/cloudflare/topology.json"), "utf8"),
    ) as {
      environments: {
        production: {
          saasZone: { zone: string; fallbackZone?: string };
          fallbackSaasZone?: {
            zone: string;
            fallbackOrigin: string;
            cnameTarget: string;
            automaticFailover: boolean;
            activationMode: string;
            customDomainsAffected: boolean;
          };
        };
        staging: {
          fallbackSaasZone?: {
            zone: string;
            fallbackOrigin: string;
            cnameTarget: string;
            automaticFailover: boolean;
          };
        };
      };
    };

    const prodFallback = topology.environments.production.fallbackSaasZone;
    const stgFallback = topology.environments.staging.fallbackSaasZone;
    expect(prodFallback).toBeDefined();
    expect(stgFallback).toBeDefined();
    expect(prodFallback?.zone).toBe("situsku.my.id");
    expect(prodFallback?.fallbackOrigin).toBe("fallback.situsku.my.id");
    expect(prodFallback?.cnameTarget).toBe("cname.situsku.my.id");
    expect(prodFallback?.automaticFailover).toBe(false);
    expect(prodFallback?.activationMode).toBe("manual_operator_runbook");
    expect(prodFallback?.customDomainsAffected).toBe(false);
    expect(stgFallback?.zone).not.toBe(prodFallback?.zone);

    const runbook = fs.readFileSync(path.join(ROOT, "docs/operations/trust-positif.md"), "utf8");
    for (const phrase of [
      "trustpositif.komdigi.go.id",
      "ipaddress_isp",
      "Turunkan situs",
      "situsku.my.id",
      "Surat Pernyataan Kepemilikan Domain",
      "Bukti Pembelian",
      "Pembersihan Konten",
      "PSE Lingkup Privat",
    ]) {
      expect(runbook).toContain(phrase);
    }

    const apiDoc = fs.readFileSync(path.join(ROOT, "docs/api/shared-domain-protection.md"), "utf8");
    expect(apiDoc).toContain("/api/console/abuse/screening");
    expect(apiDoc).toContain("/api/console/abuse/takedown");
    expect(apiDoc).toContain("/api/console/abuse/trust-watch");

    // Extract helper sanity check
    const extracted = extractPublishContent({
      title: "Judul",
      text: "![alt tersembunyi](https://example.com/a.png)",
    });
    expect(extracted.texts.some((t) => t.kind === "image_alt" && t.value === "alt tersembunyi")).toBe(
      true,
    );
  });

  it("enforces base-nova UI hygiene (zero @radix-ui/*, zero asChild, zero Sparkles) in all TASK-103 UI files", () => {
    const uiFiles = [
      "apps/web/src/pages/console/abuse/index.astro",
      "apps/web/src/pages/console/abuse/screening.astro",
      "apps/web/src/pages/console/abuse/_SharedDomainProtectionPanel.tsx",
      "apps/web/src/pages/console/abuse/_OwnerHeldNoticeCard.tsx",
    ];
    for (const rel of uiFiles) {
      const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
      expect(src).not.toMatch(/@radix-ui\//);
      expect(src).not.toMatch(/\basChild\b/);
      expect(src).not.toMatch(/\bSparkles(?:Icon)?\b/);
    }
  });
});

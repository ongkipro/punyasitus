import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import {
  AiWritingProviderError,
  type AiWritingProviderPort,
  type AiWritingProviderRequest,
} from "@punyasitus/core/ai-writing/index";
import {
  applyOnboardingAiDraftToBlueprint,
  buildOnboardingAiDraftProviderRequest,
  buildPlainOnboardingBlueprint,
  detectPiiInOnboardingAnswers,
  EMPTY_ONBOARDING_BLUEPRINT_FACTS,
  isOnboardingAiProviderConfigured,
  markAsContohDraft,
  ONBOARDING_AI_DRAFT_MARKER,
  ONBOARDING_AI_DRAFT_PREFIX,
  parseAndSanitizeOnboardingAiDraftOutput,
  resolveDefaultBlueprintForVertical,
  scrubForbiddenFactsFromText,
  type OnboardingAiDraftApiResponse,
} from "@punyasitus/core/onboarding/ai-draft/index";
import { detectSampleClaimsInSection } from "@punyasitus/core/presets/index";
import { PLATFORM_0029_AI_WRITING_USAGE_SQL, getAiWritingQuotaStatus } from "@punyasitus/db/ai-usage/index";
import {
  TENANT_STORE_PROTOCOL,
  type Row,
  type StatementDescriptor,
  type TenantStoreNamespaceLike,
} from "@punyasitus/db/connections";
import { PLATFORM_0001_SQL } from "@punyasitus/db/platform/migrations";
import { handleOnboardingAiDraftRequest } from "../../apps/web/src/pages/api/onboarding/_ai-draft-handler.ts";

vi.mock("cloudflare:workers", () => ({ env: {} }));

const { handleOnboardingStatusRequest } = await import(
  "../../apps/web/src/pages/api/onboarding/status.ts"
);

const ROOT = path.resolve(import.meta.dirname, "../..");

/**
 * Minimal D1Database adapter backed by Node's built-in `node:sqlite` (`DatabaseSync`)
 * so unit tests execute real `PLATFORM_DB` & `TenantStore` SQL, CHECK constraints,
 * foreign keys, atomic DEC-028 quota reservations, and append-only audit triggers.
 */
function createSqliteD1(db: DatabaseSync): D1Database {
  function runDescriptor(sql: string, args: unknown[]) {
    const stmt = db.prepare(sql);
    const trimmed = sql.trim().toUpperCase();
    const returnsRows =
      trimmed.startsWith("SELECT") ||
      trimmed.startsWith("PRAGMA") ||
      trimmed.startsWith("WITH") ||
      trimmed.includes("RETURNING");
    if (returnsRows) {
      const rows = stmt.all(...(args as never[])) as Record<string, unknown>[];
      return {
        results: rows,
        success: true,
        meta: { changes: 0, last_row_id: 0 },
      };
    }
    const res = stmt.run(...(args as never[]));
    return {
      results: [] as Record<string, unknown>[],
      success: true,
      meta: {
        changes: Number(res.changes ?? 0),
        last_row_id: Number(res.lastInsertRowid ?? 0),
      },
    };
  }

  class Stmt {
    readonly #sql: string;
    readonly #args: unknown[];
    constructor(sql: string, args: unknown[] = []) {
      this.#sql = sql;
      this.#args = args;
    }
    bind(...values: unknown[]) {
      return new Stmt(this.#sql, values);
    }
    async first<T = Record<string, unknown>>(col?: string): Promise<T | null> {
      const res = runDescriptor(this.#sql, this.#args);
      const row = res.results[0];
      if (!row) return null;
      if (col !== undefined) return (row[col] ?? null) as T | null;
      return row as T;
    }
    async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
      return runDescriptor(this.#sql, this.#args) as unknown as D1Result<T>;
    }
    async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
      return this.run<T>();
    }
    async raw(options?: { columnNames?: boolean }): Promise<unknown[]> {
      const stmt = db.prepare(this.#sql);
      stmt.setReturnArrays(true);
      const rows = stmt.all(...(this.#args as never[])) as unknown as unknown[][];
      if (options?.columnNames) {
        const cols = stmt.columns().map((c) => c.name);
        return [cols, ...rows];
      }
      return rows;
    }
    _exec() {
      return runDescriptor(this.#sql, this.#args);
    }
  }

  return {
    prepare(sql: string) {
      return new Stmt(sql) as unknown as D1PreparedStatement;
    },
    async batch(stmts: D1PreparedStatement[]) {
      return stmts.map((s) => (s as unknown as Stmt)._exec()) as unknown as D1Result[];
    },
    async exec(sql: string) {
      db.exec(sql);
      return { count: 1, duration: 0 };
    },
  } as unknown as D1Database;
}

function createInMemoryTenantStore(tenantDbs: Map<string, DatabaseSync>): TenantStoreNamespaceLike {
  const ensureTenantDb = (name: string): DatabaseSync => {
    let db = tenantDbs.get(name);
    if (!db) {
      db = new DatabaseSync(":memory:");
      db.exec(`
        CREATE TABLE IF NOT EXISTS pages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          slug TEXT NOT NULL UNIQUE,
          title TEXT NOT NULL,
          is_homepage INTEGER NOT NULL DEFAULT 0,
          draft_sections_json TEXT NOT NULL,
          published_sections_json TEXT,
          seo_json TEXT,
          status TEXT NOT NULL DEFAULT 'draft',
          published_at INTEGER,
          content_modified_at INTEGER,
          deleted_at INTEGER,
          version INTEGER NOT NULL DEFAULT 1,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);
      tenantDbs.set(name, db);
    }
    return db;
  };

  return {
    getByName(name: string) {
      const db = ensureTenantDb(name);
      return {
        async query(protocol: number, statement: StatementDescriptor) {
          if (protocol !== TENANT_STORE_PROTOCOL) throw new Error("protocol mismatch");
          const stmt = db.prepare(statement.sql);
          const upper = statement.sql.trim().toUpperCase();
          if (upper.startsWith("SELECT") || upper.includes("RETURNING")) {
            const rows = stmt.all(...(statement.args as never[])) as Row[];
            return {
              columns: rows[0] ? Object.keys(rows[0]) : [],
              results: rows,
              meta: {
                duration: 0,
                size_after: 0,
                changed_db: false,
                changes: 0,
                last_row_id: 0,
                rows_read: rows.length,
                rows_written: 0,
              },
            };
          }
          const res = stmt.run(...(statement.args as never[]));
          const changes = Number(res.changes ?? 0);
          return {
            columns: [],
            results: [] as Row[],
            meta: {
              duration: 0,
              size_after: 0,
              changed_db: changes > 0,
              changes,
              last_row_id: Number(res.lastInsertRowid ?? 0),
              rows_read: 0,
              rows_written: changes,
            },
          };
        },
        async batch(protocol: number, statements: StatementDescriptor[]) {
          if (protocol !== TENANT_STORE_PROTOCOL) throw new Error("protocol mismatch");
          const out = [];
          for (const st of statements) {
            out.push(await this.query(protocol, st, false));
          }
          return out;
        },
        async schemaState() {
          return {
            protocol: TENANT_STORE_PROTOCOL,
            version: 1,
            appliedMigrations: [],
            recovery: false,
          };
        },
      };
    },
  };
}

function createSeededPlatformFixture(nowMs = Date.UTC(2026, 10, 24, 10, 0, 0)) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  sqlite.exec(PLATFORM_0001_SQL);
  sqlite.exec(PLATFORM_0029_AI_WRITING_USAGE_SQL);

  // Seed Owner A + Tenant A (trial) and Owner B + Tenant B (trial)
  const ownerA = "usr_owner_a_109";
  const ownerB = "usr_owner_b_109";
  const orgA = "org_a_109";
  const orgB = "org_b_109";
  const tenantA = "01JT109TENANTA000000000001";
  const tenantB = "01JT109TENANTB000000000002";
  const trialEndsAt = nowMs + 7 * 24 * 60 * 60 * 1000;

  sqlite
    .prepare(
      `INSERT INTO users (id, name, email, email_verified, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?), (?, ?, ?, 1, ?, ?)`,
    )
    .run(ownerA, "Owner Alpha", "alpha@contoh.test", nowMs, nowMs, ownerB, "Owner Beta", "beta@contoh.test", nowMs, nowMs);

  sqlite
    .prepare(
      `INSERT INTO organizations (id, name, slug, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)`,
    )
    .run(orgA, "Alpha Org", "alpha-org", nowMs, nowMs, orgB, "Beta Org", "beta-org", nowMs, nowMs);

  sqlite
    .prepare(
      `INSERT INTO members (id, organization_id, user_id, role, created_at)
       VALUES (?, ?, ?, 'owner', ?), (?, ?, ?, 'owner', ?)`,
    )
    .run("mem_a", orgA, ownerA, nowMs, "mem_b", orgB, ownerB, nowMs);

  sqlite
    .prepare(
      `INSERT INTO tenants (
         id, organization_id, handle, name, vertical, status, trial_ends_at,
         cache_version, schema_version, version, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'compro', 'trial', ?, 1, 1, 1, ?, ?),
                (?, ?, ?, ?, 'travel', 'trial', ?, 1, 1, 1, ?, ?)`,
    )
    .run(
      tenantA,
      orgA,
      "karya-kemas",
      "PT Karya Kemas Nusantara",
      trialEndsAt,
      nowMs,
      nowMs,
      tenantB,
      orgB,
      "safa-travel",
      "Safa Wisata Nusantara",
      trialEndsAt,
      nowMs,
      nowMs,
    );

  sqlite
    .prepare(
      `INSERT INTO tenant_hosts (host, tenant_id, kind, status, ssl_status, is_primary, created_at, updated_at)
       VALUES (?, ?, 'subdomain', 'active', 'active', 1, ?, ?),
              (?, ?, 'subdomain', 'active', 'active', 1, ?, ?)`,
    )
    .run(
      "karya-kemas.situsku.click",
      tenantA,
      nowMs,
      nowMs,
      "safa-travel.situsku.click",
      tenantB,
      nowMs,
      nowMs,
    );

  const platformDb = createSqliteD1(sqlite);
  const tenantDbs = new Map<string, DatabaseSync>();
  const tenantStore = createInMemoryTenantStore(tenantDbs);

  return {
    sqlite,
    platformDb,
    tenantStore,
    tenantDbs,
    ownerA,
    ownerB,
    tenantA,
    tenantB,
    nowMs,
  };
}

function createAppPostRequest(
  body: Record<string, unknown>,
  overrides: {
    readonly url?: string;
    readonly origin?: string | null;
    readonly contentType?: string;
  } = {},
): Request {
  const headers = new Headers();
  if (overrides.contentType !== undefined) {
    if (overrides.contentType) headers.set("Content-Type", overrides.contentType);
  } else {
    headers.set("Content-Type", "application/json");
  }
  if (overrides.origin !== null) {
    headers.set("Origin", overrides.origin ?? "https://app.punyasitus.com");
  }
  return new Request(overrides.url ?? "https://app.punyasitus.com/api/onboarding/ai-draft", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("TASK-109 Unit: Pure Onboarding AI Draft Fact Scrubber, CONTOH Marker & Blueprint Safety", () => {
  it("deterministically marks every generated text field with CONTOH and never double-prefixes", () => {
    expect(markAsContohDraft("Solusi Kemasan B2B Modern", 120)).toBe(
      `${ONBOARDING_AI_DRAFT_PREFIX}Solusi Kemasan B2B Modern`,
    );
    expect(markAsContohDraft("[Contoh] Solusi Kemasan B2B Modern", 120)).toBe(
      `${ONBOARDING_AI_DRAFT_PREFIX}Solusi Kemasan B2B Modern`,
    );
    expect(markAsContohDraft("CONTOH — Solusi Kemasan B2B Modern", 120)).toBe(
      `${ONBOARDING_AI_DRAFT_PREFIX}Solusi Kemasan B2B Modern`,
    );
  });

  it("deterministically strips factual JSON keys AND scrubs prices, licences, reviews, phones, and addresses from adversarial LLM output", () => {
    const adversarialLlmJson = JSON.stringify({
      // Allowed narrative fields tainted with fabricated facts
      heroEyebrow: "Mitra Kemasan Terpercaya",
      heroHeadline: "PT Karya Kemas — Mulai Rp 150.000 dengan NIB 1234567890123",
      heroSubheadline:
        "Rating 4.9/5 dari 1.200+ ulasan pelanggan. Kunjungi Jl. Sudirman No. 45 RT 02/RW 05 atau hubungi 0812-3456-7890 sekarang.",
      heroCtaLabel: "Konsultasi Layanan via WA",
      aboutHeading: "Profil Usaha Kemasan B2B",
      aboutSummary:
        "Kami menyediakan kemasan industri berkualitas untuk bisnis di Indonesia. SK Kemenag U.245/2024 dan harga Rp 250.000 tidak berlaku. Hubungi info@karya.id.",
      serviceSummaries: [
        {
          title: "Kemasan Karton Custom",
          description: "Produksi karton box sesuai kebutuhan pengiriman B2B. Harga Rp 5.000/pcs.",
          price: 5000,
          licenceNumber: "ISO 9001:2015",
        },
      ],
      // Forbidden factual keys emitted by adversarial provider
      price: "Rp 179.000",
      prices: [{ name: "Paket A", amount: 500000 }],
      licenceNumber: "NIB 9120001234567",
      skKemenagPpiu: "U.245 Tahun 2024",
      reviews: [{ author: "Budi", rating: 5, text: "Sangat memuaskan!" }],
      testimonials: [{ name: "Siti", quote: "Terbaik!" }],
      phone: "081234567890",
      whatsapp: "6281234567890",
      address: "Jl. Jenderal Sudirman No. 12, Jakarta Selatan",
    });

    const parsed = parseAndSanitizeOnboardingAiDraftOutput(adversarialLlmJson);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    // All forbidden keys MUST be stripped (capped at max 10 keys, max 40 chars each)
    expect(parsed.strippedFactKeys.length).toBeLessThanOrEqual(10);
    expect(parsed.strippedFactKeys).toEqual(
      expect.arrayContaining([
        "price",
        "prices",
        "licenceNumber",
        "skKemenagPpiu",
        "reviews",
        "testimonials",
        "phone",
        "whatsapp",
        "address",
      ]),
    );

    const plain = buildPlainOnboardingBlueprint({
      businessName: "PT Karya Kemas Nusantara",
      vertical: "compro",
      blueprintId: "b2b_corporate",
      shortDescription: "Manufaktur kemasan karton untuk kebutuhan pengiriman bisnis.",
    });

    const drafted = applyOnboardingAiDraftToBlueprint(plain, parsed);

    // Unpublished CONTOH draft invariants
    expect(drafted.source).toBe("ai_draft");
    expect(drafted.status).toBe("draft");
    expect(drafted.published).toBe(false);
    expect(drafted.autoPublished).toBe(false);
    expect(drafted.draftMarker).toBe(ONBOARDING_AI_DRAFT_MARKER);

    // Every generated text field carries explicit CONTOH prefix
    expect(drafted.textFields.heroEyebrow.startsWith("CONTOH — ")).toBe(true);
    expect(drafted.textFields.heroHeadline.startsWith("CONTOH — ")).toBe(true);
    expect(drafted.textFields.heroSubheadline.startsWith("CONTOH — ")).toBe(true);
    expect(drafted.textFields.heroCtaLabel.startsWith("CONTOH — ")).toBe(true);
    expect(drafted.textFields.aboutHeading.startsWith("CONTOH — ")).toBe(true);
    expect(drafted.textFields.aboutSummary.startsWith("CONTOH — ")).toBe(true);
    for (const svc of drafted.textFields.serviceSummaries) {
      expect(svc.title.startsWith("CONTOH — ")).toBe(true);
      expect(svc.description.startsWith("CONTOH — ")).toBe(true);
    }

    // Zero leaked prices, licences, reviews, phones, emails, or street addresses anywhere in textFields!
    const serializedFields = JSON.stringify(drafted.textFields);
    expect(serializedFields).not.toMatch(/Rp\s?\d/i);
    expect(serializedFields).not.toContain("150.000");
    expect(serializedFields).not.toContain("250.000");
    expect(serializedFields).not.toContain("5.000");
    expect(serializedFields).not.toContain("1234567890123");
    expect(serializedFields).not.toContain("U.245");
    expect(serializedFields).not.toContain("4.9/5");
    expect(serializedFields).not.toContain("1.200+");
    expect(serializedFields).not.toContain("0812");
    expect(serializedFields).not.toContain("info@karya.id");
    expect(serializedFields).not.toContain("Sudirman");
    expect(serializedFields).not.toContain("RT 02");

    // Structured fact slots stay strictly empty/untouched
    expect(drafted.facts).toEqual(EMPTY_ONBOARDING_BLUEPRINT_FACTS);
    expect(drafted.facts.price).toBe("");
    expect(drafted.facts.licenceNumber).toBe("");
    expect(drafted.facts.reviews).toEqual([]);
    expect(drafted.facts.phone).toBe("");
    expect(drafted.facts.whatsapp).toBe("");
    expect(drafted.facts.address).toBe("");

    // Section-level checks: testimonials OFF & empty, contact_location has no address/phone/WA, offerings empty
    const testimonialsSec = drafted.sections.find((s) => s.type === "testimonials");
    expect(testimonialsSec?.enabled).toBe(false);
    expect(testimonialsSec?.type === "testimonials" && testimonialsSec.config.items).toEqual([]);

    const contactSec = drafted.sections.find((s) => s.type === "contact_location");
    expect(contactSec?.type === "contact_location" && contactSec.config.address).toBeUndefined();
    expect(contactSec?.type === "contact_location" && contactSec.config.phone).toBeUndefined();
    expect(contactSec?.type === "contact_location" && contactSec.config.whatsappPhone).toBeUndefined();

    const offeringsSec = drafted.sections.find((s) => s.type === "services_grid");
    expect(offeringsSec?.type === "services_grid" && offeringsSec.config.items).toEqual([]);

    // Every modified narrative section MUST be caught by TASK-043/093 sample-claim publish blocker
    for (const sec of drafted.sections) {
      if (sec.type === "hero" || sec.type === "about" || sec.type === "features") {
        expect(
          detectSampleClaimsInSection(sec).length,
          `Section ${sec.id} must be blocked from accidental publish by sample detector`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it("scrubs Unicode star ratings, full-width NFKC digits, bare prices/discounts, customer-count claims, and 1-word street names", () => {
    const adversarialCases: readonly { readonly input: string; readonly forbidden: readonly string[] }[] = [
      {
        input: "Layanan premium ★★★★★ dan ⭐ 4.9 untuk bisnis modern.",
        forbidden: ["★", "⭐", "4.9"],
      },
      {
        input: "Paket usaha mulai 5 juta atau hanya 99rb dengan diskon 20% bulan ini.",
        forbidden: ["5 juta", "99rb", "20%"],
      },
      {
        input: "Tersedia pilihan 150 ribu hingga 1,5 juta serta promo ５００ ribu untuk perusahaan.",
        forbidden: ["150 ribu", "1,5 juta", "500 ribu", "５００"],
      },
      {
        input: "Dipercaya 10.000+ pelanggan dan 500+ klien aktif di seluruh Indonesia.",
        forbidden: ["10.000+", "500+"],
      },
      {
        input: "Kunjungi kantor kami di Jl. Sudirman atau Gg. Mawar untuk konsultasi.",
        forbidden: ["Sudirman", "Mawar", "Jl.", "Gg."],
      },
    ];

    for (const tc of adversarialCases) {
      const scrubbed = scrubForbiddenFactsFromText(tc.input);
      for (const token of tc.forbidden) {
        expect(
          scrubbed.text,
          `Expected "${token}" scrubbed from "${tc.input}", got "${scrubbed.text}"`,
        ).not.toContain(token);
      }
      expect(scrubbed.matchedCategories.length).toBeGreaterThan(0);
    }

    // Verify strippedFactKeys cap (<= 10 items, <= 40 chars each)
    const manyExtraKeys: Record<string, unknown> = {
      heroHeadline: "PT Karya Kemas Nusantara",
      heroSubheadline: "Mitra kemasan industri untuk perusahaan Indonesia.",
    };
    for (let i = 0; i < 20; i += 1) {
      manyExtraKeys[`fact_${i}_${"x".repeat(50)}`] = "bad";
    }
    const parsedMany = parseAndSanitizeOnboardingAiDraftOutput(JSON.stringify(manyExtraKeys));
    expect(parsedMany.ok).toBe(true);
    if (parsedMany.ok) {
      expect(parsedMany.strippedFactKeys.length).toBe(10);
      for (const k of parsedMany.strippedFactKeys) {
        expect(k.length).toBeLessThanOrEqual(40);
      }
    }
  });

  it("scrubs residual PII completely and detects PII in onboarding answers before any AI call", () => {
    const piiAttempt = scrubForbiddenFactsFromText("Hubungi WA081299988877 atau boss@toko.id");
    expect(piiAttempt.text).not.toContain("0812");
    expect(piiAttempt.text).not.toContain("boss@toko.id");

    const answerCheck = detectPiiInOnboardingAnswers({
      businessName: "Toko Maju",
      vertical: "catalog",
      blueprintId: resolveDefaultBlueprintForVertical("catalog"),
      shortDescription: "Hubungi kami di 0812-9988-7766 atau sales@tokomaju.id",
    });
    expect(answerCheck.blocked).toBe(true);
    expect(answerCheck.detectedKinds).toEqual(expect.arrayContaining(["phone", "email"]));

    const providerReq = buildOnboardingAiDraftProviderRequest({
      businessName: "Toko Maju",
      vertical: "catalog",
      blueprintId: resolveDefaultBlueprintForVertical("catalog"),
      shortDescription: "Etalase peralatan dapur modern untuk restoran dan kafe.",
    });
    expect(providerReq.fieldKind).toBe("offering_description");
    expect(providerReq.systemPrompt).toContain("DILARANG KERAS mengarang fakta");
    expect(providerReq.userPrompt).toContain("Toko Maju");
  });

  it("detects provider configuration accurately and respects explicit disable flag", () => {
    expect(isOnboardingAiProviderConfigured({})).toBe(false);
    expect(isOnboardingAiProviderConfigured({ AI: null })).toBe(false);
    expect(
      isOnboardingAiProviderConfigured({
        AI: { run: async () => ({ response: "{}" }) },
      }),
    ).toBe(true);
    expect(
      isOnboardingAiProviderConfigured({
        AI: { run: async () => ({ response: "{}" }) },
        AI_ONBOARDING_ENABLED: "false",
      }),
    ).toBe(false);
    expect(isOnboardingAiProviderConfigured({}, null)).toBe(false);
  });
});

describe("TASK-109 API Handler: Auth, CSRF, Tenant Ownership, DEC-028 Quota, Skip & Graceful Fallback", () => {
  it("generates CONTOH text-only draft, persists unpublished draft in TenantStore, and consumes 1 DEC-028 quota slot", async () => {
    const fx = createSeededPlatformFixture();
    let capturedRequest: AiWritingProviderRequest | null = null;

    const mockProvider: AiWritingProviderPort = {
      async generateSuggestion(req) {
        capturedRequest = req;
        return {
          suggestion: JSON.stringify({
            heroEyebrow: "Solusi Kemasan Industri",
            heroHeadline: "PT Karya Kemas Nusantara — Mitra Produksi Kemasan B2B",
            heroSubheadline:
              "Mendukung kebutuhan karton box custom dan pengemasan industri untuk perusahaan di Indonesia.",
            heroCtaLabel: "Konsultasi Kebutuhan Kemasan",
            aboutHeading: "Tentang PT Karya Kemas Nusantara",
            aboutSummary:
              "Fokus pada ketepatan spesifikasi kemasan, kendali mutu konsisten, dan layanan responsif bagi tim pengadaan bisnis.",
            serviceSummaries: [
              {
                title: "Produksi Karton Custom",
                description: "Ukuran dan ketebalan disesuaikan dengan karakteristik produk bisnis Anda.",
              },
              {
                title: "Pengadaan Kontrak Rutin",
                description: "Penjadwalan pasokan berkala agar operasional gudang berjalan lancar.",
              },
            ],
            // Adversarial extras injected by mock provider to verify deterministic stripping
            price: "Rp 500.000",
            licenceNumber: "NIB 9988776655443",
            reviews: [{ author: "Andi", rating: 5 }],
            phone: "081234567890",
            address: "Jl. Gatot Subroto No. 10, Jakarta",
          }),
          model: "@cf/meta/llama-3.1-8b-instruct-fast",
          tokenCount: 215,
          latencyMs: 120,
        };
      },
    };

    const res = await handleOnboardingAiDraftRequest(
      createAppPostRequest({
        tenantId: fx.tenantA,
        action: "generate",
        businessName: "PT Karya Kemas Nusantara",
        vertical: "compro",
        blueprintId: "b2b_corporate",
        shortDescription: "Pabrik kemasan karton box custom untuk klien manufaktur dan distribusi.",
      }),
      {
        APP_ENV: "production",
        PLATFORM_DOMAIN: "punyasitus.com",
        PLATFORM_DB: fx.platformDb,
        TENANT_STORE: fx.tenantStore,
      },
      {
        authenticatedUser: { id: fx.ownerA },
        providerPort: mockProvider,
        nowMs: fx.nowMs,
      },
    );

    expect(res.status).toBe(200);
    const data = (await res.json()) as OnboardingAiDraftApiResponse;
    expect(data.success).toBe(true);
    expect(data.status).toBe("generated");
    expect(data.applied).toBe(true);
    expect(data.published).toBe(false);
    expect(data.autoPublished).toBe(false);
    expect(data.draftMarker).toBe("CONTOH");
    expect(data.persistedAsDraft).toBe(true);
    expect(data.strippedFactKeys).toEqual(
      expect.arrayContaining(["price", "licenceNumber", "reviews", "phone", "address"]),
    );
    expect(data.draft?.heroHeadline).toContain("CONTOH — ");
    expect(data.blueprint.facts).toEqual(EMPTY_ONBOARDING_BLUEPRINT_FACTS);

    // DEC-028 quota decremented atomically by 1
    expect(data.quota?.used).toBe(1);
    expect(data.quota?.limit).toBe(100);
    expect(data.quota?.remaining).toBe(99);
    const quotaInDb = await getAiWritingQuotaStatus(fx.platformDb, fx.tenantA, { nowMs: fx.nowMs });
    expect(quotaInDb.used).toBe(1);

    // Prompt passed ONLY the 3 onboarding answers (never tenant IDs, emails, or leads)
    expect(capturedRequest).not.toBeNull();
    expect(capturedRequest!.userPrompt).toContain("PT Karya Kemas Nusantara");
    expect(capturedRequest!.userPrompt).not.toContain(fx.tenantA);
    expect(capturedRequest!.userPrompt).not.toContain("alpha@contoh.test");

    // Verify TenantStore persisted strictly as UNPUBLISHED draft (`status = 'draft'`, `published_sections_json = NULL`)
    const tenantDb = fx.tenantDbs.get(fx.tenantA)!;
    const pageRow = tenantDb
      .prepare("SELECT status, published_sections_json, published_at, title FROM pages WHERE is_homepage = 1")
      .get() as {
      status: string;
      published_sections_json: string | null;
      published_at: number | null;
      title: string;
    };
    expect(pageRow.status).toBe("draft");
    expect(pageRow.published_sections_json).toBeNull();
    expect(pageRow.published_at).toBeNull();
    expect(pageRow.title.startsWith("CONTOH — ")).toBe(true);

    // Metadata-only audit: zero prompt or generated text stored in platform_audit
    const auditRow = fx.sqlite
      .prepare("SELECT action, outcome, metadata_json FROM platform_audit ORDER BY created_at DESC LIMIT 1")
      .get() as { action: string; outcome: string; metadata_json: string };
    expect(auditRow.action).toBe("ai_writing.suggest");
    expect(auditRow.outcome).toBe("success");
    expect(auditRow.metadata_json).not.toContain("PT Karya Kemas");
    expect(auditRow.metadata_json).not.toContain("karton box");
  });

  it("skips cleanly without calling provider, modifying blueprint, or consuming DEC-028 quota", async () => {
    const fx = createSeededPlatformFixture();
    let providerCalled = false;
    const mockProvider: AiWritingProviderPort = {
      async generateSuggestion() {
        providerCalled = true;
        throw new Error("Should never be called on skip");
      },
    };

    const res = await handleOnboardingAiDraftRequest(
      createAppPostRequest({
        tenantId: fx.tenantA,
        action: "skip",
        businessName: "PT Karya Kemas Nusantara",
        vertical: "compro",
        blueprintId: "b2b_corporate",
      }),
      {
        APP_ENV: "production",
        PLATFORM_DOMAIN: "punyasitus.com",
        PLATFORM_DB: fx.platformDb,
        TENANT_STORE: fx.tenantStore,
      },
      {
        authenticatedUser: { id: fx.ownerA },
        providerPort: mockProvider,
        nowMs: fx.nowMs,
      },
    );

    expect(res.status).toBe(200);
    const data = (await res.json()) as OnboardingAiDraftApiResponse;
    expect(data.status).toBe("skipped");
    expect(data.skipped).toBe(true);
    expect(data.applied).toBe(false);
    expect(data.draft).toBeNull();
    expect(data.blueprint.source).toBe("plain_blueprint");
    expect(data.blueprint.facts).toEqual(EMPTY_ONBOARDING_BLUEPRINT_FACTS);
    expect(providerCalled).toBe(false);
    expect(fx.tenantDbs.has(fx.tenantA)).toBe(false);

    const quotaInDb = await getAiWritingQuotaStatus(fx.platformDb, fx.tenantA, { nowMs: fx.nowMs });
    expect(quotaInDb.used).toBe(0);
  });

  it("gracefully falls back to plain blueprint on DEC-028 quota exhaustion without blocking onboarding", async () => {
    const fx = createSeededPlatformFixture();
    // Pre-fill 2 succeeded slots and run with quotaLimit: 2
    for (let i = 0; i < 2; i += 1) {
      fx.sqlite
        .prepare(
          `INSERT INTO ai_writing_usage (
             id, tenant_id, actor_user_id, field_kind, vertical, status, request_id, created_at, completed_at
           ) VALUES (?, ?, ?, 'offering_description', 'compro', 'succeeded', ?, ?, ?)`,
        )
        .run(`aiu_seed_${i}`, fx.tenantA, fx.ownerA, `req_seed_${i}`, fx.nowMs - 1000, fx.nowMs - 500);
    }

    let providerCalled = false;
    const mockProvider: AiWritingProviderPort = {
      async generateSuggestion() {
        providerCalled = true;
        return { suggestion: "{}", model: "test", tokenCount: 1, latencyMs: 1 };
      },
    };

    const res = await handleOnboardingAiDraftRequest(
      createAppPostRequest({
        tenantId: fx.tenantA,
        action: "generate",
        businessName: "PT Karya Kemas Nusantara",
        vertical: "compro",
      }),
      {
        APP_ENV: "production",
        PLATFORM_DOMAIN: "punyasitus.com",
        PLATFORM_DB: fx.platformDb,
      },
      {
        authenticatedUser: { id: fx.ownerA },
        providerPort: mockProvider,
        quotaLimit: 2,
        nowMs: fx.nowMs,
      },
    );

    expect(res.status).toBe(200);
    const data = (await res.json()) as OnboardingAiDraftApiResponse;
    expect(data.status).toBe("fallback");
    expect(data.fallback).toBe(true);
    expect(data.fallbackReason).toBe("AI_QUOTA_EXCEEDED");
    expect(data.applied).toBe(false);
    expect(data.blueprint.source).toBe("plain_blueprint");
    expect(data.quota?.remaining).toBe(0);
    expect(providerCalled).toBe(false);
  });

  it("gracefully falls back and refunds DEC-028 quota (0 consumed) on provider failure, timeout, or invalid output", async () => {
    const scenarios: readonly {
      readonly label: string;
      readonly expectedReason: string;
      readonly provider: AiWritingProviderPort;
    }[] = [
      {
        label: "provider timeout",
        expectedReason: "AI_PROVIDER_TIMEOUT",
        provider: {
          async generateSuggestion() {
            throw new AiWritingProviderError("AI_PROVIDER_TIMEOUT", "timeout", 504);
          },
        },
      },
      {
        label: "provider 502 error",
        expectedReason: "AI_PROVIDER_ERROR",
        provider: {
          async generateSuggestion() {
            throw new Error("Upstream Workers AI unavailable");
          },
        },
      },
      {
        label: "invalid non-JSON output",
        expectedReason: "AI_INVALID_OUTPUT",
        provider: {
          async generateSuggestion() {
            return {
              suggestion: "Maaf, saya tidak bisa mengembalikan JSON.",
              model: "@cf/meta/llama-3.1-8b-instruct-fast",
              tokenCount: 12,
              latencyMs: 50,
            };
          },
        },
      },
    ];

    for (const sc of scenarios) {
      const fx = createSeededPlatformFixture();
      const res = await handleOnboardingAiDraftRequest(
        createAppPostRequest({
          tenantId: fx.tenantA,
          action: "generate",
          businessName: "PT Karya Kemas Nusantara",
          vertical: "compro",
        }),
        {
          APP_ENV: "production",
          PLATFORM_DOMAIN: "punyasitus.com",
          PLATFORM_DB: fx.platformDb,
        },
        {
          authenticatedUser: { id: fx.ownerA },
          providerPort: sc.provider,
          nowMs: fx.nowMs,
        },
      );

      expect(res.status, sc.label).toBe(200);
      const data = (await res.json()) as OnboardingAiDraftApiResponse;
      expect(data.status, sc.label).toBe("fallback");
      expect(data.fallback, sc.label).toBe(true);
      expect(data.fallbackReason, sc.label).toBe(sc.expectedReason);
      expect(data.blueprint.source, sc.label).toBe("plain_blueprint");
      expect(data.draft, sc.label).toBeNull();

      // Quota slot MUST be released/refunded so 0 quota is consumed!
      const quotaAfter = await getAiWritingQuotaStatus(fx.platformDb, fx.tenantA, {
        nowMs: fx.nowMs,
      });
      expect(quotaAfter.used, `${sc.label} must consume 0 quota`).toBe(0);
    }
  });

  it("bypasses cleanly when AI provider is unconfigured (both status and ai-draft endpoints)", async () => {
    const fx = createSeededPlatformFixture();
    const res = await handleOnboardingAiDraftRequest(
      createAppPostRequest({
        tenantId: fx.tenantA,
        action: "generate",
        businessName: "PT Karya Kemas Nusantara",
        vertical: "compro",
      }),
      {
        APP_ENV: "production",
        PLATFORM_DOMAIN: "punyasitus.com",
        PLATFORM_DB: fx.platformDb,
        AI: null,
      },
      {
        authenticatedUser: { id: fx.ownerA },
        nowMs: fx.nowMs,
      },
    );

    expect(res.status).toBe(200);
    const data = (await res.json()) as OnboardingAiDraftApiResponse;
    expect(data.status).toBe("fallback");
    expect(data.fallbackReason).toBe("AI_PROVIDER_UNCONFIGURED");
    expect(data.blueprint.source).toBe("plain_blueprint");

    const quotaInDb = await getAiWritingQuotaStatus(fx.platformDb, fx.tenantA, { nowMs: fx.nowMs });
    expect(quotaInDb.used).toBe(0);

    // Status endpoint reports unauthenticated cleanly without leaking AI config
    const unauthStatusRes = await handleOnboardingStatusRequest(
      new Request("https://app.punyasitus.com/api/onboarding/status", { method: "GET" }),
      {
        APP_ENV: "production",
        PLATFORM_DOMAIN: "punyasitus.com",
        PLATFORM_DB: fx.platformDb,
        AUTH_SECRET: "test-secret-012345678901234567890123456789",
        AI: null,
      },
    );
    expect(unauthStatusRes.status).toBe(401);
  });

  it("blocks PII in onboarding shortDescription with 422 AI_PII_DETECTED before consuming quota or calling provider", async () => {
    const fx = createSeededPlatformFixture();
    let providerCalled = false;

    const res = await handleOnboardingAiDraftRequest(
      createAppPostRequest({
        tenantId: fx.tenantA,
        action: "generate",
        businessName: "PT Karya Kemas Nusantara",
        vertical: "compro",
        shortDescription: "Hubungi admin@karya.id atau WhatsApp 0812-3456-7890 untuk pemesanan.",
      }),
      {
        APP_ENV: "production",
        PLATFORM_DOMAIN: "punyasitus.com",
        PLATFORM_DB: fx.platformDb,
      },
      {
        authenticatedUser: { id: fx.ownerA },
        providerPort: {
          async generateSuggestion() {
            providerCalled = true;
            return { suggestion: "{}", model: "test", tokenCount: 1, latencyMs: 1 };
          },
        },
        nowMs: fx.nowMs,
      },
    );

    expect(res.status).toBe(422);
    const data = (await res.json()) as { code: string; detectedKinds: string[] };
    expect(data.code).toBe("AI_PII_DETECTED");
    expect(data.detectedKinds).toEqual(expect.arrayContaining(["email", "phone"]));
    expect(providerCalled).toBe(false);

    const quotaInDb = await getAiWritingQuotaStatus(fx.platformDb, fx.tenantA, { nowMs: fx.nowMs });
    expect(quotaInDb.used).toBe(0);
  });

  it("enforces unauthenticated (401), CSRF Origin (403), wrong host (404), and cross-tenant ownership (403/404) checks", async () => {
    const fx = createSeededPlatformFixture();
    const env = {
      APP_ENV: "production",
      PLATFORM_DOMAIN: "punyasitus.com",
      PLATFORM_DB: fx.platformDb,
      AUTH_SECRET: "test-secret-012345678901234567890123456789",
    };

    // 1. Unauthenticated -> 401
    const unauth = await handleOnboardingAiDraftRequest(
      createAppPostRequest({
        tenantId: fx.tenantA,
        action: "generate",
        businessName: "PT Karya Kemas",
        vertical: "compro",
      }),
      env,
      { nowMs: fx.nowMs },
    );
    expect(unauth.status).toBe(401);

    // 2. Cross-origin CSRF -> 403
    const badCsrf = await handleOnboardingAiDraftRequest(
      createAppPostRequest(
        {
          tenantId: fx.tenantA,
          action: "generate",
          businessName: "PT Karya Kemas",
          vertical: "compro",
        },
        { origin: "https://evil.example.com" },
      ),
      env,
      { authenticatedUser: { id: fx.ownerA }, nowMs: fx.nowMs },
    );
    expect(badCsrf.status).toBe(403);

    // 3. Wrong host (tenant host instead of app.punyasitus.com) -> 404
    const wrongHost = await handleOnboardingAiDraftRequest(
      createAppPostRequest(
        {
          tenantId: fx.tenantA,
          action: "generate",
          businessName: "PT Karya Kemas",
          vertical: "compro",
        },
        {
          url: "https://karya-kemas.situsku.click/api/onboarding/ai-draft",
          origin: "https://karya-kemas.situsku.click",
        },
      ),
      env,
      { authenticatedUser: { id: fx.ownerA }, nowMs: fx.nowMs },
    );
    expect(wrongHost.status).toBe(404);

    // 4. Cross-tenant attempt (Owner B trying to draft for Owner A's tenant) -> 403 or 404
    const crossTenant = await handleOnboardingAiDraftRequest(
      createAppPostRequest({
        tenantId: fx.tenantA,
        action: "generate",
        businessName: "PT Karya Kemas",
        vertical: "compro",
      }),
      env,
      {
        authenticatedUser: { id: fx.ownerB },
        providerPort: {
          async generateSuggestion() {
            throw new Error("Provider must NEVER run for cross-tenant caller");
          },
        },
        nowMs: fx.nowMs,
      },
    );
    expect([403, 404]).toContain(crossTenant.status);

    // 5. Forbidden extra client field (`published: true` / `price: 100`) -> 422
    const forbiddenField = await handleOnboardingAiDraftRequest(
      createAppPostRequest({
        tenantId: fx.tenantA,
        action: "generate",
        businessName: "PT Karya Kemas",
        vertical: "compro",
        published: true,
      }),
      env,
      { authenticatedUser: { id: fx.ownerA }, nowMs: fx.nowMs },
    );
    expect(forbiddenField.status).toBe(422);
  });

  it("never overwrites an already user-edited draft homepage, never touches published columns, and enforces OCC version check", async () => {
    const fx = createSeededPlatformFixture();
    const validProvider: AiWritingProviderPort = {
      async generateSuggestion() {
        return {
          suggestion: JSON.stringify({
            heroEyebrow: "Profil Kemasan",
            heroHeadline: "PT Karya Kemas Nusantara — Solusi Kemasan Bisnis",
            heroSubheadline: "Layanan pengemasan profesional untuk kebutuhan distribusi B2B.",
            heroCtaLabel: "Hubungi Tim",
            aboutHeading: "Tentang Usaha",
            aboutSummary: "Berfokus pada ketepatan spesifikasi kemasan dan layanan pengadaan.",
          }),
          model: "@cf/meta/llama-3.1-8b-instruct-fast",
          tokenCount: 150,
          latencyMs: 90,
        };
      },
    };

    // 1. Seed a user-edited draft homepage with pre-existing sentinel values in published_sections_json / published_at
    const tenantDb = new DatabaseSync(":memory:");
    tenantDb.exec(`
      CREATE TABLE pages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slug TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        is_homepage INTEGER NOT NULL DEFAULT 0,
        draft_sections_json TEXT NOT NULL,
        published_sections_json TEXT,
        seo_json TEXT,
        status TEXT NOT NULL DEFAULT 'draft',
        published_at INTEGER,
        content_modified_at INTEGER,
        deleted_at INTEGER,
        version INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    const userEditedPayload = JSON.stringify({
      slug: "beranda",
      title: "Beranda Asli Milik Owner",
      sections: [{ id: "owner-hero", kind: "hero", heading: "Teks Asli Owner" }],
    });
    const sentinelPublishedJson = '{"sentinel":"preserved-published-snapshot"}';
    const sentinelPublishedAt = fx.nowMs - 86_400_000;
    tenantDb
      .prepare(
        `INSERT INTO pages (
           slug, title, is_homepage, draft_sections_json, published_sections_json,
           status, published_at, version, created_at, updated_at
         ) VALUES ('beranda', 'Beranda Asli Milik Owner', 1, ?, ?, 'draft', ?, 3, ?, ?)`,
      )
      .run(userEditedPayload, sentinelPublishedJson, sentinelPublishedAt, fx.nowMs, fx.nowMs);
    fx.tenantDbs.set(fx.tenantA, tenantDb);

    const res1 = await handleOnboardingAiDraftRequest(
      createAppPostRequest({
        tenantId: fx.tenantA,
        action: "generate",
        businessName: "PT Karya Kemas Nusantara",
        vertical: "compro",
      }),
      {
        APP_ENV: "production",
        PLATFORM_DOMAIN: "punyasitus.com",
        PLATFORM_DB: fx.platformDb,
        TENANT_STORE: fx.tenantStore,
      },
      {
        authenticatedUser: { id: fx.ownerA },
        providerPort: validProvider,
        nowMs: fx.nowMs,
      },
    );
    expect(res1.status).toBe(200);
    const data1 = (await res1.json()) as OnboardingAiDraftApiResponse;
    expect(data1.status).toBe("generated");
    expect(data1.persistedAsDraft).toBe(false);
    expect(data1.message).toContain("tidak ditimpa");

    // User-edited draft and published columns MUST remain 100% untouched
    const rowAfter1 = tenantDb
      .prepare("SELECT title, draft_sections_json, published_sections_json, published_at, version FROM pages WHERE is_homepage = 1")
      .get() as {
      title: string;
      draft_sections_json: string;
      published_sections_json: string | null;
      published_at: number | null;
      version: number;
    };
    expect(rowAfter1.title).toBe("Beranda Asli Milik Owner");
    expect(rowAfter1.draft_sections_json).toBe(userEditedPayload);
    expect(rowAfter1.published_sections_json).toBe(sentinelPublishedJson);
    expect(rowAfter1.published_at).toBe(sentinelPublishedAt);
    expect(rowAfter1.version).toBe(3);

    // 2. Replace with an untouched onboarding AI draft (still keeping sentinel published columns!)
    //    and verify UPDATE increments version via OCC and NEVER clears published_sections_json / published_at!
    const untouchedOnboardingDraft = JSON.stringify({
      payload: {
        draftSectionsJson: JSON.stringify({
          source: "onboarding_ai_draft",
          draftMarker: "CONTOH",
          sections: [],
        }),
      },
    });
    tenantDb
      .prepare("UPDATE pages SET title = 'CONTOH — Lama', draft_sections_json = ?, version = 4 WHERE is_homepage = 1")
      .run(untouchedOnboardingDraft);

    const res2 = await handleOnboardingAiDraftRequest(
      createAppPostRequest({
        tenantId: fx.tenantA,
        action: "generate",
        businessName: "PT Karya Kemas Nusantara",
        vertical: "compro",
      }),
      {
        APP_ENV: "production",
        PLATFORM_DOMAIN: "punyasitus.com",
        PLATFORM_DB: fx.platformDb,
        TENANT_STORE: fx.tenantStore,
      },
      {
        authenticatedUser: { id: fx.ownerA },
        providerPort: validProvider,
        nowMs: fx.nowMs + 1000,
      },
    );
    expect(res2.status).toBe(200);
    const data2 = (await res2.json()) as OnboardingAiDraftApiResponse;
    expect(data2.persistedAsDraft).toBe(true);

    const rowAfter2 = tenantDb
      .prepare("SELECT title, published_sections_json, published_at, version FROM pages WHERE is_homepage = 1")
      .get() as {
      title: string;
      published_sections_json: string | null;
      published_at: number | null;
      version: number;
    };
    expect(rowAfter2.title).toContain("CONTOH — ");
    expect(rowAfter2.version).toBe(5);
    expect(rowAfter2.published_sections_json).toBe(sentinelPublishedJson);
    expect(rowAfter2.published_at).toBe(sentinelPublishedAt);

    // 3. Simulate concurrent OCC version conflict (version bumped between SELECT and UPDATE) -> persistedAsDraft: false
    const occConflictStore: TenantStoreNamespaceLike = {
      getByName(name) {
        const inner = fx.tenantStore.getByName(name);
        return {
          ...inner,
          async query(protocol, statement, raw) {
            if (statement.sql.trim().toUpperCase().startsWith("UPDATE PAGES")) {
              // Bump version right before UPDATE runs to trigger OCC mismatch
              tenantDb.prepare("UPDATE pages SET version = version + 10 WHERE is_homepage = 1").run();
            }
            return inner.query(protocol, statement, raw);
          },
        };
      },
    };

    const res3 = await handleOnboardingAiDraftRequest(
      createAppPostRequest({
        tenantId: fx.tenantA,
        action: "generate",
        businessName: "PT Karya Kemas Nusantara",
        vertical: "compro",
      }),
      {
        APP_ENV: "production",
        PLATFORM_DOMAIN: "punyasitus.com",
        PLATFORM_DB: fx.platformDb,
        TENANT_STORE: occConflictStore,
      },
      {
        authenticatedUser: { id: fx.ownerA },
        providerPort: validProvider,
        nowMs: fx.nowMs + 2000,
      },
    );
    expect(res3.status).toBe(200);
    const data3 = (await res3.json()) as OnboardingAiDraftApiResponse;
    expect(data3.status).toBe("generated");
    expect(data3.persistedAsDraft).toBe(false);
  });

  it("satisfies static guardrails: ZERO Sparkles/SparklesIcon, ZERO @radix-ui/*, ZERO asChild across TASK-109 files", () => {
    const filesToCheck = [
      "packages/core/src/onboarding/ai-draft/types.ts",
      "packages/core/src/onboarding/ai-draft/fact-scrubber.ts",
      "packages/core/src/onboarding/ai-draft/blueprint.ts",
      "packages/core/src/onboarding/ai-draft/index.ts",
      "apps/web/src/pages/auth/onboarding/_OnboardingAiDraftStep.tsx",
      "apps/web/src/pages/auth/onboarding/_OnboardingWizard.tsx",
      "apps/web/src/pages/auth/onboarding/index.astro",
      "apps/web/src/pages/api/onboarding/ai-draft.ts",
    ];
    for (const rel of filesToCheck) {
      const content = fs.readFileSync(path.join(ROOT, rel), "utf8");
      expect(content, `${rel} must not contain Sparkles`).not.toMatch(/\bSparkles(?:Icon)?\b/);
      expect(content, `${rel} must not reference @radix-ui`).not.toContain("@radix-ui/");
      expect(content, `${rel} must not use Radix asChild`).not.toMatch(/\basChild\b/);
    }
  });
});

import { env } from "cloudflare:workers";
import {
  AI_WRITING_QUOTA_WINDOW_MS,
  AiWritingProviderError,
  DEFAULT_WORKERS_AI_MODEL,
  type AiWritingProviderPort,
  type AiWritingProviderRequest,
} from "@punyasitus/core/ai-writing/index";
import type { StructuredTelemetryEvent } from "@punyasitus/core/telemetry/index";
import { applyAiWritingUsageMigration, getAiWritingQuotaStatus } from "@punyasitus/db/ai-usage/index";
import {
  applyPlatformMigrations,
  createTenantDb,
  openTenantStoreStub,
  orchestrateTenantMigration,
  type TenantStoreNamespaceLike,
} from "@punyasitus/db/connections";
import { PLATFORM_MIGRATIONS } from "@punyasitus/db/platform";
import { TENANT_MIGRATIONS } from "@punyasitus/db/tenant";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { handleAiWritingQuotaRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/ai-writing/quota.ts";
import { handleAiWritingSuggestRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/ai-writing/suggest.ts";

const APP_ORIGIN = "https://app.punyasitus.com";
const NOW_MS = Date.UTC(2026, 10, 23, 8, 0, 0);

const TENANT_A = {
  id: "01JT074TENANTALPHA00000001",
  orgId: "org_t074_alpha",
  handle: "t074-alpha",
  name: "T074 Alpha Arsitek",
  vertical: "compro" as const,
  ownerId: "user_t074_owner_a",
  editorId: "user_t074_editor_a",
  primaryHost: "t074-alpha.situsku.click",
};

const TENANT_B = {
  id: "01JT074TENANTBETA000000002",
  orgId: "org_t074_beta",
  handle: "t074-beta",
  name: "T074 Beta Travel",
  vertical: "travel" as const,
  ownerId: "user_t074_owner_b",
  primaryHost: "t074-beta.situsku.click",
};

const TENANT_LOCKED = {
  id: "01JT074TENANTLOCKED0000003",
  orgId: "org_t074_locked",
  handle: "t074-locked",
  name: "T074 Locked Toko",
  vertical: "catalog" as const,
  ownerId: "user_t074_owner_locked",
  primaryHost: "t074-locked.situsku.click",
};

const TENANT_SUSPENDED = {
  id: "01JT074TENANTSUSPEND000004",
  orgId: "org_t074_suspended",
  handle: "t074-suspended",
  name: "T074 Suspended Resto",
  vertical: "resto" as const,
  ownerId: "user_t074_owner_susp",
  primaryHost: "t074-suspended.situsku.click",
};

function getTenantStoreNs(): TenantStoreNamespaceLike {
  return env.TENANT_STORE as unknown as TenantStoreNamespaceLike;
}

function buildRuntimeEnv() {
  return {
    APP_ENV: "test",
    PLATFORM_DOMAIN: "punyasitus.com",
    PLATFORM_DB: env.PLATFORM_DB,
  };
}

function makeAppRequest(
  path: string,
  init: {
    readonly method?: string;
    readonly body?: unknown;
    readonly origin?: string | null;
    readonly host?: string;
  } = {},
): Request {
  const method = init.method ?? "GET";
  const headers = new Headers();
  if (method !== "GET" && method !== "HEAD") {
    if (init.origin !== null) {
      headers.set("Origin", init.origin ?? APP_ORIGIN);
    }
    headers.set("Sec-Fetch-Site", "same-origin");
    if (init.body !== undefined) {
      headers.set("Content-Type", "application/json");
    }
  }
  const base = init.host ? `https://${init.host}` : APP_ORIGIN;
  return new Request(`${base}${path}`, {
    method,
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
}

async function seedTenant(spec: {
  readonly id: string;
  readonly orgId: string;
  readonly handle: string;
  readonly name: string;
  readonly vertical: "compro" | "sales" | "travel" | "catalog" | "resto" | "dealer";
  readonly ownerId: string;
  readonly editorId?: string;
  readonly status: "active" | "locked" | "suspended";
  readonly paidThroughMs: number;
  readonly primaryHost: string;
}) {
  const db = env.PLATFORM_DB;

  await db
    .prepare(
      `INSERT OR REPLACE INTO users (id, name, email, email_verified, two_factor_enabled, created_at, updated_at)
       VALUES (?, ?, ?, 1, 0, ?, ?)`,
    )
    .bind(spec.ownerId, `Owner ${spec.handle}`, `${spec.ownerId}@example.com`, NOW_MS, NOW_MS)
    .run();

  if (spec.editorId) {
    await db
      .prepare(
        `INSERT OR REPLACE INTO users (id, name, email, email_verified, two_factor_enabled, created_at, updated_at)
         VALUES (?, ?, ?, 1, 0, ?, ?)`,
      )
      .bind(spec.editorId, `Editor ${spec.handle}`, `${spec.editorId}@example.com`, NOW_MS, NOW_MS)
      .run();
  }

  await db
    .prepare(
      `INSERT OR REPLACE INTO organizations (id, name, slug, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(spec.orgId, spec.name, spec.handle, NOW_MS, NOW_MS)
    .run();

  await db
    .prepare(
      `INSERT OR REPLACE INTO tenants (
         id, organization_id, handle, name, vertical, status, operator_hold,
         paid_through, cache_version, schema_version, version, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, 1, 0, 1, ?, ?)`,
    )
    .bind(
      spec.id,
      spec.orgId,
      spec.handle,
      spec.name,
      spec.vertical,
      spec.status,
      spec.paidThroughMs,
      NOW_MS,
      NOW_MS,
    )
    .run();

  await db
    .prepare(
      `INSERT OR REPLACE INTO members (id, organization_id, user_id, role, created_at)
       VALUES (?, ?, ?, 'owner', ?)`,
    )
    .bind(`mem_${spec.ownerId}`, spec.orgId, spec.ownerId, NOW_MS)
    .run();

  if (spec.editorId) {
    await db
      .prepare(
        `INSERT OR REPLACE INTO members (id, organization_id, user_id, role, created_at)
         VALUES (?, ?, ?, 'editor', ?)`,
      )
      .bind(`mem_${spec.editorId}`, spec.orgId, spec.editorId, NOW_MS)
      .run();
  }

  await db
    .prepare(
      `INSERT OR REPLACE INTO tenant_hosts (
         host, tenant_id, kind, status, is_primary, created_at, updated_at
       ) VALUES (?, ?, 'subdomain', 'active', 1, ?, ?)`,
    )
    .bind(spec.primaryHost, spec.id, NOW_MS, NOW_MS)
    .run();
}

describe("TASK-074 workerd integration — AI Writing privacy, PII guard, 100/30d quota & security", () => {
  beforeAll(async () => {
    await applyPlatformMigrations(env.PLATFORM_DB, PLATFORM_MIGRATIONS);
    await applyAiWritingUsageMigration(env.PLATFORM_DB);

    const activePaid = NOW_MS + 30 * 86_400_000;
    const lockedPaid = NOW_MS - 5 * 86_400_000; // H+5 -> locked
    const suspendedPaid = NOW_MS - 10 * 86_400_000; // H+10 -> suspended

    await seedTenant({ ...TENANT_A, status: "active", paidThroughMs: activePaid });
    await seedTenant({ ...TENANT_B, status: "active", paidThroughMs: activePaid });
    await seedTenant({ ...TENANT_LOCKED, status: "locked", paidThroughMs: lockedPaid });
    await seedTenant({ ...TENANT_SUSPENDED, status: "suspended", paidThroughMs: suspendedPaid });

    // Initialize Tenant A DO with a saved page to verify AI suggestions NEVER auto-save content
    const stubA = openTenantStoreStub(getTenantStoreNs(), TENANT_A.id);
    await orchestrateTenantMigration(env.PLATFORM_DB, stubA, TENANT_A.id, TENANT_MIGRATIONS);
    const tenantDbA = createTenantDb(stubA);
    await tenantDbA
      .prepare(
        `INSERT OR REPLACE INTO pages (
           id, title, slug, status, is_homepage,
           draft_sections_json, published_sections_json, version, created_at, updated_at
         ) VALUES (1, 'Judul Asli Tersimpan', 'beranda', 'published', 1, '[]', '[]', 1, ?, ?)`,
      )
      .bind(NOW_MS, NOW_MS)
      .run();
  });

  beforeEach(async () => {
    await env.PLATFORM_DB.prepare("DELETE FROM ai_writing_usage").run();
    await env.PLATFORM_DB.prepare("DELETE FROM ai_writing_rate_buckets").run();
  });

  it("sends ONLY selected fields + authoritative vertical, never auto-saves content, and logs zero prompt/suggestion text", async () => {
    const capturedRequests: AiWritingProviderRequest[] = [];
    const capturedTelemetry: StructuredTelemetryEvent[] = [];

    const SENTINEL_INPUT = "SENTINEL_PROMPT_RAHASIA_T074 renovasi ruang rapat Jakarta";
    const SENTINEL_OUTPUT = "SENTINEL_SUGGESTION_RAHASIA_T074 Layanan Renovasi Ruang Rapat Modern";

    const mockProvider: AiWritingProviderPort = {
      async generateSuggestion(req) {
        capturedRequests.push(req);
        return {
          suggestion: SENTINEL_OUTPUT,
          model: DEFAULT_WORKERS_AI_MODEL,
          tokenCount: 84,
          latencyMs: 120,
        };
      },
    };

    const req = makeAppRequest(`/api/tenants/${TENANT_A.handle}/ai-writing/suggest`, {
      method: "POST",
      body: {
        fieldKind: "title",
        selectedFields: ["currentText", "category"],
        fields: {
          currentText: SENTINEL_INPUT,
          category: "Arsitektur Kantor",
        },
        tone: "profesional",
      },
    });

    const res = await handleAiWritingSuggestRequest(TENANT_A.handle, req, buildRuntimeEnv(), {
      authenticatedUser: { id: TENANT_A.editorId },
      providerPort: mockProvider,
      telemetrySink: (e) => capturedTelemetry.push(e),
      nowMs: NOW_MS,
      requestId: "req_t074_clean_001",
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      suggestion: string;
      fieldKind: string;
      vertical: string;
      quota: { used: number; limit: number; remaining: number };
      factCheckReminder: string;
    };

    expect(json.suggestion).toBe(SENTINEL_OUTPUT);
    expect(json.vertical).toBe("compro");
    expect(json.quota).toMatchObject({ used: 1, limit: 100, remaining: 99 });
    expect(json.factCheckReminder).toContain("Periksa kembali fakta");

    // Provider received ONLY selected fields + authoritative vertical
    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0]?.vertical).toBe("compro");
    expect(capturedRequests[0]?.selectedFieldKeys).toEqual(["currentText", "category"]);
    expect(capturedRequests[0]?.selectedFields).toEqual({
      currentText: SENTINEL_INPUT,
      category: "Arsitektur Kantor",
    });

    // TenantStore content MUST remain completely unchanged (never auto-saved!)
    const tenantDbA = createTenantDb(openTenantStoreStub(getTenantStoreNs(), TENANT_A.id));
    const savedPage = await tenantDbA
      .prepare("SELECT title, version FROM pages WHERE id = 1")
      .first<{ title: string; version: number }>();
    expect(savedPage).toEqual({ title: "Judul Asli Tersimpan", version: 1 });

    // ZERO prompt text or suggestion text in ai_writing_usage, platform_audit, or telemetry!
    const usageRows = await env.PLATFORM_DB.prepare("SELECT * FROM ai_writing_usage").all();
    const auditRows = await env.PLATFORM_DB.prepare(
      "SELECT * FROM platform_audit WHERE request_id = 'req_t074_clean_001'",
    ).all();

    expect(usageRows.results).toHaveLength(1);
    expect(auditRows.results).toHaveLength(1);
    expect(capturedTelemetry).toHaveLength(1);

    const allStoredText = JSON.stringify({
      usage: usageRows.results,
      audit: auditRows.results,
      telemetry: capturedTelemetry,
    });
    expect(allStoredText).not.toContain(SENTINEL_INPUT);
    expect(allStoredText).not.toContain(SENTINEL_OUTPUT);
    expect(allStoredText).not.toContain("SENTINEL_PROMPT_RAHASIA_T074");
    expect(allStoredText).not.toContain("SENTINEL_SUGGESTION_RAHASIA_T074");
  });

  it("blocks selected text containing emails, Indonesian/intl phone numbers, or NIK with 422 BEFORE provider call and consumes 0 quota", async () => {
    let providerCalls = 0;
    const mockProvider: AiWritingProviderPort = {
      async generateSuggestion() {
        providerCalls += 1;
        return { suggestion: "Should never run", model: DEFAULT_WORKERS_AI_MODEL, tokenCount: 10, latencyMs: 10 };
      },
    };

    const piiSamples = [
      { text: "Hubungi budi.santoso@contoh.id untuk penawaran", expectedKind: "email", rawNeedle: "budi.santoso@contoh.id" },
      { text: "hubungi kami...info@toko.id segera", expectedKind: "email", rawNeedle: "info@toko.id" },
      { text: "Chat WhatsApp ke 0812-3456-7890 sekarang", expectedKind: "phone", rawNeedle: "0812-3456-7890" },
      { text: "Hubungi (+62) 812 3456 7890 atau WA08123456789 atau Tel08123456789", expectedKind: "phone", rawNeedle: "8123456789" },
      { text: "Kontak HP08123456789 atau 08123456789a atau (021) 555-9876", expectedKind: "phone", rawNeedle: "555-9876" },
      { text: "Pemilik NIK 3171051205900001 dan NPWP 123456789012345 resmi", expectedKind: "nik", rawNeedle: "123456789012345" },
    ];

    for (const [idx, sample] of piiSamples.entries()) {
      const req = makeAppRequest(`/api/tenants/${TENANT_A.handle}/ai-writing/suggest`, {
        method: "POST",
        body: {
          fieldKind: "excerpt",
          selectedFields: ["currentText"],
          fields: { currentText: sample.text },
        },
      });
      const res = await handleAiWritingSuggestRequest(TENANT_A.handle, req, buildRuntimeEnv(), {
        authenticatedUser: { id: TENANT_A.ownerId },
        providerPort: mockProvider,
        burstPolicy: { perUserPerMinute: 20, perTenantPerMinute: 30 },
        nowMs: NOW_MS,
        requestId: `req_t074_pii_${idx}`,
      });

      expect(res.status).toBe(422);
      const bodyText = await res.text();
      const parsed = JSON.parse(bodyText) as {
        error: { code: string; message: string; detectedKinds: string[] };
      };
      expect(parsed.error.code).toBe("AI_PII_DETECTED");
      expect(parsed.error.detectedKinds).toContain(sample.expectedKind);
      // Never echo raw PII back in response or audit logs
      expect(bodyText).not.toContain(sample.rawNeedle);
    }

    expect(providerCalls).toBe(0);
    const quota = await getAiWritingQuotaStatus(env.PLATFORM_DB, TENANT_A.id, { nowMs: NOW_MS });
    expect(quota.used).toBe(0);
    expect(quota.remaining).toBe(100);
  });

  it("rejects control-character-only payloads with 422 without consuming quota or calling provider, and burst-throttles repeated PII requests to prevent audit flooding", async () => {
    let providerCalls = 0;
    const mockProvider: AiWritingProviderPort = {
      async generateSuggestion() {
        providerCalls += 1;
        return { suggestion: "Never", model: DEFAULT_WORKERS_AI_MODEL, tokenCount: 1, latencyMs: 1 };
      },
    };

    // 1. Control-char-only input -> 422 VALIDATION_ERROR, 0 provider calls, 0 quota
    const controlRes = await handleAiWritingSuggestRequest(
      TENANT_A.handle,
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/ai-writing/suggest`, {
        method: "POST",
        body: {
          fieldKind: "title",
          selectedFields: ["currentText"],
          fields: { currentText: "\u0000\u0007\u001b\u007f" },
        },
      }),
      buildRuntimeEnv(),
      { authenticatedUser: { id: TENANT_A.ownerId }, providerPort: mockProvider, nowMs: NOW_MS },
    );
    expect(controlRes.status).toBe(422);
    const controlBody = (await controlRes.json()) as { error: { code: string } };
    expect(controlBody.error.code).toBe("VALIDATION_ERROR");

    // 2. Repeated PII requests hit 429 AI_RATE_LIMITED once burst limit is reached & cap platform_audit growth
    const beforeAuditRow = await env.PLATFORM_DB.prepare(
      "SELECT COUNT(*) AS cnt FROM platform_audit WHERE tenant_id = ? AND reason = 'AI_PII_DETECTED'",
    )
      .bind(TENANT_A.id)
      .first<{ cnt: number }>();
    const auditBefore = Number(beforeAuditRow?.cnt ?? 0);

    for (let i = 0; i < 2; i += 1) {
      const piiRes = await handleAiWritingSuggestRequest(
        TENANT_A.handle,
        makeAppRequest(`/api/tenants/${TENANT_A.handle}/ai-writing/suggest`, {
          method: "POST",
          body: {
            fieldKind: "excerpt",
            selectedFields: ["currentText"],
            fields: { currentText: "Hubungi spam@contoh.id segera" },
          },
        }),
        buildRuntimeEnv(),
        {
          authenticatedUser: { id: TENANT_A.editorId },
          providerPort: mockProvider,
          burstPolicy: { perUserPerMinute: 2, perTenantPerMinute: 10 },
          nowMs: NOW_MS + 120_000,
        },
      );
      expect(piiRes.status).toBe(422);
    }

    // 3rd repeated PII request in same minute MUST be burst-throttled (429) and NOT write another audit row!
    const throttledPiiRes = await handleAiWritingSuggestRequest(
      TENANT_A.handle,
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/ai-writing/suggest`, {
        method: "POST",
        body: {
          fieldKind: "excerpt",
          selectedFields: ["currentText"],
          fields: { currentText: "Hubungi spam@contoh.id segera" },
        },
      }),
      buildRuntimeEnv(),
      {
        authenticatedUser: { id: TENANT_A.editorId },
        providerPort: mockProvider,
        burstPolicy: { perUserPerMinute: 2, perTenantPerMinute: 10 },
        nowMs: NOW_MS + 125_000,
      },
    );
    expect(throttledPiiRes.status).toBe(429);
    const throttledBody = (await throttledPiiRes.json()) as { error: { code: string } };
    expect(throttledBody.error.code).toBe("AI_RATE_LIMITED");

    const afterAuditRow = await env.PLATFORM_DB.prepare(
      "SELECT COUNT(*) AS cnt FROM platform_audit WHERE tenant_id = ? AND reason = 'AI_PII_DETECTED'",
    )
      .bind(TENANT_A.id)
      .first<{ cnt: number }>();
    expect(Number(afterAuditRow?.cnt ?? 0) - auditBefore).toBe(2);

    expect(providerCalls).toBe(0);
    const quota = await getAiWritingQuotaStatus(env.PLATFORM_DB, TENANT_A.id, { nowMs: NOW_MS + 125_000 });
    expect(quota.used).toBe(0);
  });

  it("opportunistically prunes >90-day ai_writing_usage metadata rows and >1h expired burst buckets", async () => {
    const expiredUsageMs = NOW_MS - 91 * 86_400_000;
    const recentUsageMs = NOW_MS - 5 * 86_400_000;
    const expiredBucketMs = NOW_MS - 2 * 3_600_000;

    await env.PLATFORM_DB.batch([
      env.PLATFORM_DB.prepare(
        `INSERT INTO ai_writing_usage (
           id, tenant_id, actor_user_id, field_kind, vertical, status,
           model, token_count, latency_ms, request_id, created_at, completed_at
         ) VALUES ('aiu_old_91d', ?, ?, 'title', 'compro', 'succeeded', ?, 30, 15, 'req_old_91d', ?, ?)`,
      ).bind(TENANT_A.id, TENANT_A.ownerId, DEFAULT_WORKERS_AI_MODEL, expiredUsageMs, expiredUsageMs + 15),
      env.PLATFORM_DB.prepare(
        `INSERT INTO ai_writing_usage (
           id, tenant_id, actor_user_id, field_kind, vertical, status,
           model, token_count, latency_ms, request_id, created_at, completed_at
         ) VALUES ('aiu_recent_5d', ?, ?, 'title', 'compro', 'succeeded', ?, 30, 15, 'req_recent_5d', ?, ?)`,
      ).bind(TENANT_A.id, TENANT_A.ownerId, DEFAULT_WORKERS_AI_MODEL, recentUsageMs, recentUsageMs + 15),
      env.PLATFORM_DB.prepare(
        `INSERT INTO ai_writing_rate_buckets (bucket_key, window_start, count, updated_at)
         VALUES ('aiw:u:stale:expired', ?, 3, ?)`,
      ).bind(expiredBucketMs, expiredBucketMs),
    ]);

    const mockProvider: AiWritingProviderPort = {
      async generateSuggestion() {
        return {
          suggestion: "Layanan Arsitektur Kantor Profesional",
          model: DEFAULT_WORKERS_AI_MODEL,
          tokenCount: 40,
          latencyMs: 25,
        };
      },
    };

    const res = await handleAiWritingSuggestRequest(
      TENANT_A.handle,
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/ai-writing/suggest`, {
        method: "POST",
        body: {
          fieldKind: "title",
          selectedFields: ["currentText"],
          fields: { currentText: "Arsitektur kantor modern" },
        },
      }),
      buildRuntimeEnv(),
      {
        authenticatedUser: { id: TENANT_A.ownerId },
        providerPort: mockProvider,
        nowMs: NOW_MS,
      },
    );
    expect(res.status).toBe(200);

    const oldUsage = await env.PLATFORM_DB.prepare(
      "SELECT id FROM ai_writing_usage WHERE id = 'aiu_old_91d'",
    ).first();
    const recentUsage = await env.PLATFORM_DB.prepare(
      "SELECT id FROM ai_writing_usage WHERE id = 'aiu_recent_5d'",
    ).first();
    const expiredBucket = await env.PLATFORM_DB.prepare(
      "SELECT bucket_key FROM ai_writing_rate_buckets WHERE bucket_key = 'aiw:u:stale:expired'",
    ).first();

    expect(oldUsage).toBeNull();
    expect(recentUsage).toEqual({ id: "aiu_recent_5d" });
    expect(expiredBucket).toBeNull();
  });

  it("rejects leads payloads and unselected fields with 422 before calling provider", async () => {
    let providerCalls = 0;
    const mockProvider: AiWritingProviderPort = {
      async generateSuggestion() {
        providerCalls += 1;
        return { suggestion: "Never", model: DEFAULT_WORKERS_AI_MODEL, tokenCount: 1, latencyMs: 1 };
      },
    };

    const resLeads = await handleAiWritingSuggestRequest(
      TENANT_A.handle,
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/ai-writing/suggest`, {
        method: "POST",
        body: {
          fieldKind: "title",
          selectedFields: ["title"],
          fields: { title: "Layanan Arsitek" },
          leads: [{ name: "Calon Klien", phone: "08123456789" }],
        },
      }),
      buildRuntimeEnv(),
      { authenticatedUser: { id: TENANT_A.ownerId }, providerPort: mockProvider, nowMs: NOW_MS },
    );
    expect(resLeads.status).toBe(422);

    const resUnselected = await handleAiWritingSuggestRequest(
      TENANT_A.handle,
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/ai-writing/suggest`, {
        method: "POST",
        body: {
          fieldKind: "title",
          selectedFields: ["title"],
          fields: {
            title: "Layanan Arsitek",
            summary: "Field ini tidak dicentang user",
          },
        },
      }),
      buildRuntimeEnv(),
      { authenticatedUser: { id: TENANT_A.ownerId }, providerPort: mockProvider, nowMs: NOW_MS },
    );
    expect(resUnselected.status).toBe(422);
    expect(providerCalls).toBe(0);
  });

  it("refunds quota atomically when provider fails or times out (failed calls consume 0 quota)", async () => {
    const errorProvider: AiWritingProviderPort = {
      async generateSuggestion() {
        throw new AiWritingProviderError("AI_PROVIDER_ERROR", "Upstream 502", 502);
      },
    };
    const timeoutProvider: AiWritingProviderPort = {
      async generateSuggestion() {
        throw new AiWritingProviderError("AI_PROVIDER_TIMEOUT", "Upstream timeout", 504);
      },
    };

    const res1 = await handleAiWritingSuggestRequest(
      TENANT_A.handle,
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/ai-writing/suggest`, {
        method: "POST",
        body: {
          fieldKind: "meta_description",
          selectedFields: ["currentText"],
          fields: { currentText: "Jasa arsitek kantor modern di Jakarta." },
        },
      }),
      buildRuntimeEnv(),
      { authenticatedUser: { id: TENANT_A.ownerId }, providerPort: errorProvider, nowMs: NOW_MS },
    );
    expect(res1.status).toBe(502);
    const body1 = (await res1.json()) as { error: { code: string; quota: { used: number } } };
    expect(body1.error.code).toBe("AI_PROVIDER_ERROR");
    expect(body1.error.quota.used).toBe(0);

    const res2 = await handleAiWritingSuggestRequest(
      TENANT_A.handle,
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/ai-writing/suggest`, {
        method: "POST",
        body: {
          fieldKind: "meta_description",
          selectedFields: ["currentText"],
          fields: { currentText: "Jasa arsitek kantor modern di Jakarta." },
        },
      }),
      buildRuntimeEnv(),
      { authenticatedUser: { id: TENANT_A.ownerId }, providerPort: timeoutProvider, nowMs: NOW_MS },
    );
    expect(res2.status).toBe(504);

    const quota = await getAiWritingQuotaStatus(env.PLATFORM_DB, TENANT_A.id, { nowMs: NOW_MS });
    expect(quota.used).toBe(0);
    expect(quota.remaining).toBe(100);
  });

  it("enforces exact 100 suggestions / 30-day rolling cap across all members, refuses 101st with 429, and handles concurrent races atomically", async () => {
    let providerCalls = 0;
    const mockProvider: AiWritingProviderPort = {
      async generateSuggestion(req) {
        providerCalls += 1;
        return {
          suggestion: `Draf judul #${providerCalls} untuk ${req.vertical}`,
          model: DEFAULT_WORKERS_AI_MODEL,
          tokenCount: 50,
          latencyMs: 35,
        };
      },
    };

    // Seed 98 prior succeeded suggestions across owner & editor inside the trailing 30-day window
    const stmts: D1PreparedStatement[] = [];
    for (let i = 0; i < 98; i += 1) {
      const actor = i % 2 === 0 ? TENANT_A.ownerId : TENANT_A.editorId;
      const createdAt = NOW_MS - (29 - Math.floor(i / 4)) * 86_400_000 + i * 1000;
      stmts.push(
        env.PLATFORM_DB.prepare(
          `INSERT INTO ai_writing_usage (
             id, tenant_id, actor_user_id, field_kind, vertical, status,
             model, token_count, latency_ms, request_id, created_at, completed_at
           ) VALUES (?, ?, ?, 'title', 'compro', 'succeeded', ?, 40, 20, ?, ?, ?)`,
        ).bind(`seed_aiu_${i}`, TENANT_A.id, actor, DEFAULT_WORKERS_AI_MODEL, `seed_req_${i}`, createdAt, createdAt + 20),
      );
    }
    await env.PLATFORM_DB.batch(stmts);

    // 99th succeeds via API
    const res99 = await handleAiWritingSuggestRequest(
      TENANT_A.handle,
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/ai-writing/suggest`, {
        method: "POST",
        body: {
          fieldKind: "title",
          selectedFields: ["currentText"],
          fields: { currentText: "Jasa interior kantor" },
        },
      }),
      buildRuntimeEnv(),
      {
        authenticatedUser: { id: TENANT_A.ownerId },
        providerPort: mockProvider,
        burstPolicy: { perUserPerMinute: 100, perTenantPerMinute: 100 },
        nowMs: NOW_MS,
      },
    );
    expect(res99.status).toBe(200);
    const json99 = (await res99.json()) as { quota: { used: number; remaining: number } };
    expect(json99.quota.used).toBe(99);
    expect(json99.quota.remaining).toBe(1);

    // Concurrent race at 99/100: fire 5 parallel requests — strictly 1 wins (100th), 4 get 429!
    const raceResponses = await Promise.all(
      Array.from({ length: 5 }, (_, idx) =>
        handleAiWritingSuggestRequest(
          TENANT_A.handle,
          makeAppRequest(`/api/tenants/${TENANT_A.handle}/ai-writing/suggest`, {
            method: "POST",
            body: {
              fieldKind: "title",
              selectedFields: ["currentText"],
              fields: { currentText: `Jasa interior kantor paralel ${idx}` },
            },
          }),
          buildRuntimeEnv(),
          {
            authenticatedUser: { id: idx % 2 === 0 ? TENANT_A.ownerId : TENANT_A.editorId },
            providerPort: mockProvider,
            burstPolicy: { perUserPerMinute: 100, perTenantPerMinute: 100 },
            nowMs: NOW_MS + 100,
          },
        ),
      ),
    );

    const statuses = raceResponses.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 429, 429, 429, 429]);
    expect(providerCalls).toBe(2); // 99th + exactly 1 winner for 100th!

    // 101st request is deterministically refused with 429 AI_QUOTA_EXCEEDED + Bahasa Indonesia reset time
    const res101 = await handleAiWritingSuggestRequest(
      TENANT_A.handle,
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/ai-writing/suggest`, {
        method: "POST",
        body: {
          fieldKind: "title",
          selectedFields: ["currentText"],
          fields: { currentText: "Permintaan ke-101" },
        },
      }),
      buildRuntimeEnv(),
      {
        authenticatedUser: { id: TENANT_A.editorId },
        providerPort: mockProvider,
        burstPolicy: { perUserPerMinute: 100, perTenantPerMinute: 100 },
        nowMs: NOW_MS + 200,
      },
    );
    expect(res101.status).toBe(429);
    expect(res101.headers.get("Retry-After")).toBeTruthy();
    const body101 = (await res101.json()) as {
      error: { code: string; message: string; quota: { used: number; limit: number; remaining: number; nextResetAt: string | null } };
    };
    expect(body101.error.code).toBe("AI_QUOTA_EXCEEDED");
    expect(body101.error.message).toContain("100/100");
    expect(body101.error.quota.used).toBe(100);
    expect(body101.error.quota.remaining).toBe(0);
    expect(body101.error.quota.nextResetAt).toBeTruthy();
    expect(providerCalls).toBe(2); // 101st NEVER called provider!

    // Rolling 30-day expiry: after 30 days + 1 second from the oldest seeded entry, quota frees up
    const afterRollMs = NOW_MS + AI_WRITING_QUOTA_WINDOW_MS + 10_000;
    const quotaAfterRoll = await getAiWritingQuotaStatus(env.PLATFORM_DB, TENANT_A.id, {
      nowMs: afterRollMs,
    });
    expect(quotaAfterRoll.used).toBe(0);
    expect(quotaAfterRoll.remaining).toBe(100);
  });

  it("enforces per-user per-minute burst rate limit (429 AI_RATE_LIMITED)", async () => {
    let providerCalls = 0;
    const mockProvider: AiWritingProviderPort = {
      async generateSuggestion() {
        providerCalls += 1;
        return { suggestion: "Draf singkat", model: DEFAULT_WORKERS_AI_MODEL, tokenCount: 20, latencyMs: 10 };
      },
    };

    for (let i = 0; i < 2; i += 1) {
      const okRes = await handleAiWritingSuggestRequest(
        TENANT_A.handle,
        makeAppRequest(`/api/tenants/${TENANT_A.handle}/ai-writing/suggest`, {
          method: "POST",
          body: {
            fieldKind: "title",
            selectedFields: ["currentText"],
            fields: { currentText: `Tes burst ${i}` },
          },
        }),
        buildRuntimeEnv(),
        {
          authenticatedUser: { id: TENANT_A.ownerId },
          providerPort: mockProvider,
          burstPolicy: { perUserPerMinute: 2, perTenantPerMinute: 10 },
          nowMs: NOW_MS,
        },
      );
      expect(okRes.status).toBe(200);
    }

    const burstRes = await handleAiWritingSuggestRequest(
      TENANT_A.handle,
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/ai-writing/suggest`, {
        method: "POST",
        body: {
          fieldKind: "title",
          selectedFields: ["currentText"],
          fields: { currentText: "Tes burst ke-3" },
        },
      }),
      buildRuntimeEnv(),
      {
        authenticatedUser: { id: TENANT_A.ownerId },
        providerPort: mockProvider,
        burstPolicy: { perUserPerMinute: 2, perTenantPerMinute: 10 },
        nowMs: NOW_MS + 5_000,
      },
    );
    expect(burstRes.status).toBe(429);
    expect(burstRes.headers.get("Retry-After")).toBeTruthy();
    const burstBody = (await burstRes.json()) as { error: { code: string } };
    expect(burstBody.error.code).toBe("AI_RATE_LIMITED");
    expect(providerCalls).toBe(2);
  });

  it("denies locked & suspended tenants (403 SUBSCRIPTION_LOCKED), cross-tenant access (404), non-app host (404), and missing/foreign CSRF Origin (403)", async () => {
    let providerCalls = 0;
    const mockProvider: AiWritingProviderPort = {
      async generateSuggestion() {
        providerCalls += 1;
        return { suggestion: "Never", model: DEFAULT_WORKERS_AI_MODEL, tokenCount: 1, latencyMs: 1 };
      },
    };

    const validBody = {
      fieldKind: "title",
      selectedFields: ["currentText"],
      fields: { currentText: "Produk berkualitas" },
    };

    // Locked tenant -> 403 SUBSCRIPTION_LOCKED on POST /suggest
    const lockedRes = await handleAiWritingSuggestRequest(
      TENANT_LOCKED.handle,
      makeAppRequest(`/api/tenants/${TENANT_LOCKED.handle}/ai-writing/suggest`, {
        method: "POST",
        body: validBody,
      }),
      buildRuntimeEnv(),
      { authenticatedUser: { id: TENANT_LOCKED.ownerId }, providerPort: mockProvider, nowMs: NOW_MS },
    );
    expect(lockedRes.status).toBe(403);
    const lockedJson = (await lockedRes.json()) as { error: { code: string } };
    expect(lockedJson.error.code).toBe("SUBSCRIPTION_LOCKED");

    // Suspended tenant -> 403 SUBSCRIPTION_LOCKED on both GET /quota and POST /suggest
    const suspQuotaRes = await handleAiWritingQuotaRequest(
      TENANT_SUSPENDED.handle,
      makeAppRequest(`/api/tenants/${TENANT_SUSPENDED.handle}/ai-writing/quota`),
      buildRuntimeEnv(),
      { authenticatedUser: { id: TENANT_SUSPENDED.ownerId }, nowMs: NOW_MS },
    );
    expect(suspQuotaRes.status).toBe(403);

    const suspSuggestRes = await handleAiWritingSuggestRequest(
      TENANT_SUSPENDED.handle,
      makeAppRequest(`/api/tenants/${TENANT_SUSPENDED.handle}/ai-writing/suggest`, {
        method: "POST",
        body: validBody,
      }),
      buildRuntimeEnv(),
      { authenticatedUser: { id: TENANT_SUSPENDED.ownerId }, providerPort: mockProvider, nowMs: NOW_MS },
    );
    expect(suspSuggestRes.status).toBe(403);

    // Cross-tenant access -> neutral 404 NOT_FOUND
    const crossQuota = await handleAiWritingQuotaRequest(
      TENANT_A.handle,
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/ai-writing/quota`),
      buildRuntimeEnv(),
      { authenticatedUser: { id: TENANT_B.ownerId }, nowMs: NOW_MS },
    );
    expect(crossQuota.status).toBe(404);

    const crossSuggest = await handleAiWritingSuggestRequest(
      TENANT_A.handle,
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/ai-writing/suggest`, {
        method: "POST",
        body: validBody,
      }),
      buildRuntimeEnv(),
      { authenticatedUser: { id: TENANT_B.ownerId }, providerPort: mockProvider, nowMs: NOW_MS },
    );
    expect(crossSuggest.status).toBe(404);

    // Tenant host -> 404
    const tenantHostRes = await handleAiWritingSuggestRequest(
      TENANT_A.handle,
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/ai-writing/suggest`, {
        method: "POST",
        host: TENANT_A.primaryHost,
        body: validBody,
      }),
      buildRuntimeEnv(),
      { authenticatedUser: { id: TENANT_A.ownerId }, providerPort: mockProvider, nowMs: NOW_MS },
    );
    expect(tenantHostRes.status).toBe(404);

    // Foreign Origin / CSRF -> 403
    const badCsrfRes = await handleAiWritingSuggestRequest(
      TENANT_A.handle,
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/ai-writing/suggest`, {
        method: "POST",
        origin: "https://evil.example",
        body: validBody,
      }),
      buildRuntimeEnv(),
      { authenticatedUser: { id: TENANT_A.ownerId }, providerPort: mockProvider, nowMs: NOW_MS },
    );
    expect(badCsrfRes.status).toBe(403);

    expect(providerCalls).toBe(0);
  });
});

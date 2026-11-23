import { env } from "cloudflare:workers";
import { createAuth } from "@punyasitus/auth";
import { classifyTrafficAttribution } from "@punyasitus/core/analytics/attribution";
import {
  AI_TRAINING_ONLY_CRAWLERS,
  ALLOWED_SEARCH_AND_AI_FETCHERS,
  FACETED_FILTER_DISALLOW_PATTERNS,
  isPathAllowedByRobotsTxt,
} from "@punyasitus/core/seo/robots";
import { recordFirstPartyEvent } from "@punyasitus/db/analytics/index";
import { createCatalogOffering } from "@punyasitus/db/catalog/index";
import {
  applyPlatformMigrations,
  createSqliteDrizzle,
  createTenantDb,
  openTenantStoreStub,
  orchestrateTenantMigration,
  type TenantStoreNamespaceLike,
} from "@punyasitus/db/connections";
import { executeIdempotentLeadWrite } from "@punyasitus/db/lead-dedup/index";
import { createPage } from "@punyasitus/db/pages/index";
import {
  members,
  organizations,
  PLATFORM_MIGRATIONS,
  platformSchema,
  tenantHosts,
  tenants,
  users,
} from "@punyasitus/db/platform";
import { createPost } from "@punyasitus/db/posts/index";
import { clearHostResolutionCache } from "@punyasitus/db/routing/index";
import { TENANT_MIGRATIONS } from "@punyasitus/db/tenant";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { handleIndexNowKeyRequest } from "../../apps/web/src/pages/[indexnowKey].txt.ts";
import { handleTenantCatalogOfferingPublishRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/catalog/[offeringId]/publish.ts";
import { handleTenantPagePublishRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/pages/[pageId]/publish.ts";
import { handleTenantPostPublishRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/posts/[postId]/publish.ts";
import {
  loadSeoVisibilitySnapshot,
  updateAiTrainingPolicyForTenant,
} from "../../apps/web/src/pages/dashboard/[handle]/seo/_data.ts";
import { handleSeoVisibilityApiRequest } from "../../apps/web/src/pages/dashboard/[handle]/seo/api.ts";
import { handleRobotsTxtRequest } from "../../apps/web/src/pages/robots.txt.ts";
import type { DiscoveryHandlerDeps } from "../../apps/web/src/pages/sitemaps/_shared.ts";
import {
  DEFAULT_CRON_EXPRESSION,
  dispatchScheduledCron,
  SEO_INDEXNOW_CRON_JOB_DEFINITION,
} from "../../apps/web/src/worker/cron/index.ts";
import type { JobQueuePayload } from "../../apps/web/src/worker/env.d.ts";
import { processDurableQueueBatch } from "../../apps/web/src/worker/queues/consumer.ts";
import {
  createSeoJobRegistry,
  enqueueIndexNowPublishPing,
  ensureTenantIndexNowKey,
} from "../../apps/web/src/worker/queues/seo/index.ts";

const BASE_TIME = 1_845_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

const TENANT_CUSTOM_A = {
  id: "01JT095A000000000000000001",
  orgId: "org_t095_custom_a",
  handle: "t095-alpha",
  name: "Alpha Wisata & Logistik",
  subdomain: "t095-alpha.situsku.click",
  customDomain: "www.t095-alpha.id",
} as const;

const TENANT_CUSTOM_B = {
  id: "01JT095B000000000000000002",
  orgId: "org_t095_custom_b",
  handle: "t095-beta",
  name: "Beta Otomotif",
  subdomain: "t095-beta.situsku.click",
  customDomain: "www.t095-beta.id",
} as const;

const TENANT_TRIAL = {
  id: "01JT095T000000000000000003",
  orgId: "org_t095_trial",
  handle: "t095-trial",
  name: "Trial Studio",
  subdomain: "t095-trial.situsku.click",
} as const;

const TENANT_SUSPENDED = {
  id: "01JT095S000000000000000004",
  orgId: "org_t095_suspended",
  handle: "t095-suspended",
  name: "Suspended Corp",
  subdomain: "t095-suspended.situsku.click",
  customDomain: "www.t095-suspended.id",
} as const;

async function seedTenant(spec: {
  readonly id: string;
  readonly orgId: string;
  readonly handle: string;
  readonly name: string;
  readonly status: "active" | "trial" | "suspended";
  readonly subdomain: string;
  readonly customDomain?: string;
}): Promise<D1Database> {
  const now = new Date(BASE_TIME);
  const pDb = createSqliteDrizzle(env.PLATFORM_DB, platformSchema);

  await pDb
    .insert(organizations)
    .values({
      id: spec.orgId,
      name: spec.name,
      slug: spec.handle,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();

  await pDb
    .insert(tenants)
    .values({
      id: spec.id,
      organizationId: spec.orgId,
      handle: spec.handle,
      name: spec.name,
      status: spec.status,
      paidThrough: spec.status === "active" ? new Date(BASE_TIME + 30 * DAY_MS) : null,
      trialEndsAt: spec.status === "trial" ? new Date(BASE_TIME + 7 * DAY_MS) : null,
      cacheVersion: 1,
      schemaVersion: 0,
      version: 1,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();

  const hostRows = spec.customDomain
    ? [
        {
          host: spec.customDomain,
          tenantId: spec.id,
          kind: "custom" as const,
          status: "active" as const,
          sslStatus: "active" as const,
          isPrimary: true,
          verifiedAt: now,
          version: 1,
          createdAt: now,
          updatedAt: now,
        },
        {
          host: spec.subdomain,
          tenantId: spec.id,
          kind: "subdomain" as const,
          status: "active" as const,
          sslStatus: "active" as const,
          isPrimary: false,
          verifiedAt: now,
          version: 1,
          createdAt: now,
          updatedAt: now,
        },
      ]
    : [
        {
          host: spec.subdomain,
          tenantId: spec.id,
          kind: "subdomain" as const,
          status: "active" as const,
          sslStatus: "active" as const,
          isPrimary: true,
          verifiedAt: now,
          version: 1,
          createdAt: now,
          updatedAt: now,
        },
      ];

  for (const row of hostRows) {
    await pDb.insert(tenantHosts).values(row).onConflictDoNothing();
  }

  const tenantStoreNs = env.TENANT_STORE as unknown as TenantStoreNamespaceLike;
  const stub = openTenantStoreStub(tenantStoreNs, spec.id);
  await orchestrateTenantMigration(env.PLATFORM_DB, stub, spec.id, TENANT_MIGRATIONS);
  return createTenantDb(stub);
}

function makeDiscoveryDeps(): DiscoveryHandlerDeps {
  return {
    platformDb: env.PLATFORM_DB,
    tenantStore: env.TENANT_STORE as unknown as TenantStoreNamespaceLike,
    platformDomain: "punyasitus.com",
    saasZone: "situsku.click",
    nowMs: BASE_TIME,
    bypassHostCache: true,
  };
}

function makeFakeMessageBatch(
  messages: readonly JobQueuePayload[],
): {
  readonly batch: MessageBatch<unknown>;
  readonly acked: string[];
  readonly retried: Array<{ id: string; delaySeconds?: number }>;
} {
  const acked: string[] = [];
  const retried: Array<{ id: string; delaySeconds?: number }> = [];
  const wrapped = messages.map((body, idx) => {
    const id = `msg-${idx + 1}`;
    return {
      id,
      timestamp: new Date(BASE_TIME),
      body,
      attempts: 1,
      ack() {
        acked.push(id);
      },
      retry(opts?: QueueRetryOptions) {
        retried.push({ id, delaySeconds: opts?.delaySeconds });
      },
    };
  });

  const batch = {
    queue: "punyasitus-jobs-test",
    messages: wrapped as unknown as Message<unknown>[],
    metadata: {} as MessageBatchMetadata,
    ackAll() {
      for (const m of wrapped) m.ack();
    },
    retryAll() {
      for (const m of wrapped) m.retry();
    },
  } as MessageBatch<unknown>;
  return { batch, acked, retried };
}

describe("TASK-095: AI & Search Visibility Engine (workerd D1 + TenantStore Integration)", () => {
  let alphaDb: D1Database;
  let betaDb: D1Database;
  let trialDb: D1Database;
  let suspendedDb: D1Database;

  beforeAll(async () => {
    await applyPlatformMigrations(env.PLATFORM_DB, PLATFORM_MIGRATIONS);
    alphaDb = await seedTenant({ ...TENANT_CUSTOM_A, status: "active" });
    betaDb = await seedTenant({ ...TENANT_CUSTOM_B, status: "active" });
    trialDb = await seedTenant({ ...TENANT_TRIAL, status: "trial" });
    suspendedDb = await seedTenant({ ...TENANT_SUSPENDED, status: "suspended" });
  });

  beforeEach(() => {
    clearHostResolutionCache();
  });

  it("serves dynamic /robots.txt honoring live aiTrainingPolicy toggles while isolating trial & suspended sites", async () => {
    // 1. Update Alpha to disallow AI training bots via live TenantStore persistence
    const updatedDisallow = await updateAiTrainingPolicyForTenant({
      platformDb: env.PLATFORM_DB,
      tenantDb: alphaDb,
      tenantId: TENANT_CUSTOM_A.id,
      tenantName: TENANT_CUSTOM_A.name,
      aiTrainingPolicy: "disallow",
      nowMs: BASE_TIME,
    });
    expect(updatedDisallow.aiTrainingPolicy).toBe("disallow");

    const alphaRobotsRes = await handleRobotsTxtRequest(
      new Request(`https://${TENANT_CUSTOM_A.customDomain}/robots.txt`),
      makeDiscoveryDeps(),
    );
    expect(alphaRobotsRes.status).toBe(200);
    const alphaRobotsBody = await alphaRobotsRes.text();

    for (const bot of ALLOWED_SEARCH_AND_AI_FETCHERS) {
      expect(isPathAllowedByRobotsTxt(alphaRobotsBody, bot, "/")).toBe(true);
    }
    for (const bot of AI_TRAINING_ONLY_CRAWLERS) {
      expect(isPathAllowedByRobotsTxt(alphaRobotsBody, bot, "/")).toBe(false);
    }
    for (const pattern of FACETED_FILTER_DISALLOW_PATTERNS) {
      expect(alphaRobotsBody).toContain(`Disallow: ${pattern}`);
    }
    expect(alphaRobotsBody).toContain(`Sitemap: https://${TENANT_CUSTOM_A.customDomain}/sitemap.xml`);

    // 2. Flip Alpha back to allow AI training bots -> reflected immediately on /robots.txt
    await updateAiTrainingPolicyForTenant({
      platformDb: env.PLATFORM_DB,
      tenantDb: alphaDb,
      tenantId: TENANT_CUSTOM_A.id,
      tenantName: TENANT_CUSTOM_A.name,
      aiTrainingPolicy: "allow",
      nowMs: BASE_TIME + 1_000,
    });

    const alphaAllowBody = await (
      await handleRobotsTxtRequest(
        new Request(`https://${TENANT_CUSTOM_A.customDomain}/robots.txt`),
        makeDiscoveryDeps(),
      )
    ).text();
    for (const bot of AI_TRAINING_ONLY_CRAWLERS) {
      expect(isPathAllowedByRobotsTxt(alphaAllowBody, bot, "/")).toBe(true);
    }

    // 3. Trial & Suspended -> Disallow: / + X-Robots-Tag: noindex, nofollow, NO Sitemap
    const trialRes = await handleRobotsTxtRequest(
      new Request(`https://${TENANT_TRIAL.subdomain}/robots.txt`),
      makeDiscoveryDeps(),
    );
    expect(trialRes.status).toBe(200);
    expect(trialRes.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    const trialBody = await trialRes.text();
    expect(trialBody).toBe("User-agent: *\nDisallow: /\n");
    expect(trialBody).not.toContain("Sitemap:");

    const suspRes = await handleRobotsTxtRequest(
      new Request(`https://${TENANT_SUSPENDED.customDomain}/robots.txt`),
      makeDiscoveryDeps(),
    );
    expect(suspRes.status).toBe(503);
    expect(suspRes.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(await suspRes.text()).toBe("User-agent: *\nDisallow: /\n");
  });

  it("serves /<key>.txt ONLY on verified custom domain with exact tenant key and returns 404 on .situsku.click, wrong key, cross-tenant key, suspended, or /llms.txt", async () => {
    const alphaKey = (await ensureTenantIndexNowKey(alphaDb, { nowMs: BASE_TIME })).key;
    const betaKey = (await ensureTenantIndexNowKey(betaDb, { nowMs: BASE_TIME })).key;
    const trialKey = (await ensureTenantIndexNowKey(trialDb, { nowMs: BASE_TIME })).key;
    const suspKey = (await ensureTenantIndexNowKey(suspendedDb, { nowMs: BASE_TIME })).key;

    expect(alphaKey).not.toBe(betaKey);

    // 1. Valid request on Alpha's verified custom domain -> 200 exact plain-text key
    const okRes = await handleIndexNowKeyRequest(
      new Request(`https://${TENANT_CUSTOM_A.customDomain}/${alphaKey}.txt`),
      alphaKey,
      makeDiscoveryDeps(),
    );
    expect(okRes.status).toBe(200);
    expect(okRes.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await okRes.text()).toBe(alphaKey);

    // 2. Cross-tenant key (Beta's key requested on Alpha's domain) -> 404
    const crossTenantRes = await handleIndexNowKeyRequest(
      new Request(`https://${TENANT_CUSTOM_A.customDomain}/${betaKey}.txt`),
      betaKey,
      makeDiscoveryDeps(),
    );
    expect(crossTenantRes.status).toBe(404);

    // 3. Wrong key on Alpha's custom domain -> 404
    const wrongKeyRes = await handleIndexNowKeyRequest(
      new Request(`https://${TENANT_CUSTOM_A.customDomain}/${"f".repeat(32)}.txt`),
      "f".repeat(32),
      makeDiscoveryDeps(),
    );
    expect(wrongKeyRes.status).toBe(404);

    // 4. Alpha's .situsku.click alias subdomain -> 404 (custom domain only!)
    const aliasSubdomainRes = await handleIndexNowKeyRequest(
      new Request(`https://${TENANT_CUSTOM_A.subdomain}/${alphaKey}.txt`),
      alphaKey,
      makeDiscoveryDeps(),
    );
    expect(aliasSubdomainRes.status).toBe(404);

    // 5. Trial tenant on .situsku.click -> 404
    const trialRes = await handleIndexNowKeyRequest(
      new Request(`https://${TENANT_TRIAL.subdomain}/${trialKey}.txt`),
      trialKey,
      makeDiscoveryDeps(),
    );
    expect(trialRes.status).toBe(404);

    // 6. Suspended tenant even on custom domain -> 404
    const suspRes = await handleIndexNowKeyRequest(
      new Request(`https://${TENANT_SUSPENDED.customDomain}/${suspKey}.txt`),
      suspKey,
      makeDiscoveryDeps(),
    );
    expect(suspRes.status).toBe(404);

    // 7. Unknown host & speculative /llms.txt -> 404
    const unknownRes = await handleIndexNowKeyRequest(
      new Request(`https://unknown-host.example.test/${alphaKey}.txt`),
      alphaKey,
      makeDiscoveryDeps(),
    );
    expect(unknownRes.status).toBe(404);

    const llmsRes = await handleIndexNowKeyRequest(
      new Request(`https://${TENANT_CUSTOM_A.customDomain}/llms.txt`),
      "llms",
      makeDiscoveryDeps(),
    );
    expect(llmsRes.status).toBe(404);
  });

  it("enqueues ONE deduplicated IndexNow ping across CMS & confirmed MCP publishes, flushes via cron, and skips .situsku.click trials", async () => {
    const queuedMessages: JobQueuePayload[] = [];
    const fakeQueue = {
      async send(msg: JobQueuePayload) {
        queuedMessages.push(msg);
      },
    };

    const tenantStoreNs = env.TENANT_STORE as unknown as TenantStoreNamespaceLike;

    // 1. Trial tenant publish -> strictly skipped (0 queued messages, 0 fetch calls)
    const trialAttempt = await enqueueIndexNowPublishPing(
      {
        PLATFORM_DB: env.PLATFORM_DB,
        JOBS_QUEUE: fakeQueue,
        TENANT_STORE: tenantStoreNs,
      },
      {
        tenantId: TENANT_TRIAL.id,
        urls: ["/blog/artikel-trial"],
        source: "cms",
        nowMs: BASE_TIME,
      },
    );
    expect(trialAttempt.enqueued).toBe(false);
    expect(queuedMessages).toHaveLength(0);

    // 2. Verified custom-domain CMS publish + duplicate confirmed MCP publish in same dedup window
    const cmsPing = await enqueueIndexNowPublishPing(
      {
        PLATFORM_DB: env.PLATFORM_DB,
        JOBS_QUEUE: fakeQueue,
        TENANT_STORE: tenantStoreNs,
      },
      {
        tenantId: TENANT_CUSTOM_A.id,
        urls: [
          "/blog/paket-umrah-2027?utm_source=chatgpt.com",
          "/tour/umrah-vip",
          "/kendaraan?brand=toyota&year=2025", // faceted query filtered out
        ],
        source: "cms",
        dedupBucket: "t095-window-1",
        nowMs: BASE_TIME,
      },
    );
    expect(cmsPing.enqueued).toBe(true);
    expect(queuedMessages).toHaveLength(1);

    // Confirmed MCP publish for the same URLs within the same window -> deduplicated!
    const mcpDuplicate = await enqueueIndexNowPublishPing(
      {
        PLATFORM_DB: env.PLATFORM_DB,
        JOBS_QUEUE: fakeQueue,
        TENANT_STORE: tenantStoreNs,
      },
      {
        tenantId: TENANT_CUSTOM_A.id,
        urls: [
          `https://${TENANT_CUSTOM_A.customDomain}/tour/umrah-vip`,
          `https://${TENANT_CUSTOM_A.customDomain}/blog/paket-umrah-2027`,
        ],
        source: "mcp",
        dedupBucket: "t095-window-1",
        nowMs: BASE_TIME + 5_000,
      },
    );
    expect(mcpDuplicate.enqueued).toBe(false);
    expect(mcpDuplicate.deduplicated).toBe(true);
    expect(queuedMessages).toHaveLength(1);

    // 3. Process the queue batch with mocked IndexNow fetch -> exactly ONE POST sent!
    const fetchCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const mockFetch: typeof fetch = async (input, init) => {
      fetchCalls.push({
        url: String(input),
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      });
      return new Response("", { status: 200 });
    };

    const registry = createSeoJobRegistry({ fetchImpl: mockFetch });
    const { batch, acked } = makeFakeMessageBatch(queuedMessages);
    const batchRes = await processDurableQueueBatch(
      batch,
      { PLATFORM_DB: env.PLATFORM_DB, TENANT_STORE: env.TENANT_STORE, SAAS_ZONE: "situsku.click" },
      registry,
      { now: () => BASE_TIME + 10_000, logger: () => {} },
    );

    expect(batchRes.completed).toBe(1);
    expect(acked).toHaveLength(1);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.url).toBe("https://api.indexnow.org/indexnow");
    expect(fetchCalls[0]?.body.host).toBe(TENANT_CUSTOM_A.customDomain);
    expect(fetchCalls[0]?.body.urlList).toEqual([
      `https://${TENANT_CUSTOM_A.customDomain}/blog/paket-umrah-2027`,
      `https://${TENANT_CUSTOM_A.customDomain}/tour/umrah-vip`,
    ]);

    // 4. Separate confirmed MCP publish (new URL) -> enqueued and flushed via Cron handler
    const cronQueueMessages: JobQueuePayload[] = [];
    const mcpFresh = await enqueueIndexNowPublishPing(
      {
        PLATFORM_DB: env.PLATFORM_DB,
        JOBS_QUEUE: {
          async send() {
            // Simulate direct cron flush picking up pending buffer on Beta
          },
        },
        TENANT_STORE: tenantStoreNs,
      },
      {
        tenantId: TENANT_CUSTOM_B.id,
        urls: ["/kendaraan/avanza-2026"],
        source: "mcp",
        dedupBucket: "t095-mcp-beta",
        nowMs: BASE_TIME + 20_000,
      },
    );
    expect(mcpFresh.enqueued).toBe(true);

    const cronDispatch = await dispatchScheduledCron(
      { cron: DEFAULT_CRON_EXPRESSION, scheduledTime: BASE_TIME + 3_600_000 },
      {
        PLATFORM_DB: env.PLATFORM_DB,
        JOBS_QUEUE: {
          async send(msg: JobQueuePayload) {
            cronQueueMessages.push(msg);
          },
        } as unknown as Queue<JobQueuePayload>,
      },
      [SEO_INDEXNOW_CRON_JOB_DEFINITION],
      { now: () => BASE_TIME + 3_600_000, logger: () => {} },
    );
    expect(cronDispatch.enqueuedCount).toBe(1);
    expect(cronQueueMessages).toHaveLength(1);

    const { batch: cronBatch } = makeFakeMessageBatch(cronQueueMessages);
    const cronBatchRes = await processDurableQueueBatch(
      cronBatch,
      { PLATFORM_DB: env.PLATFORM_DB, TENANT_STORE: env.TENANT_STORE, SAAS_ZONE: "situsku.click" },
      registry,
      { now: () => BASE_TIME + 3_601_000, logger: () => {} },
    );
    expect(cronBatchRes.completed).toBe(1);
    expect(fetchCalls).toHaveLength(2);
    expect(fetchCalls[1]?.body.host).toBe(TENANT_CUSTOM_B.customDomain);
    expect(fetchCalls[1]?.body.urlList).toEqual([
      `https://${TENANT_CUSTOM_B.customDomain}/kendaraan/avanza-2026`,
    ]);
  });

  it("attributes events, WhatsApp clicks, and leads from AI referrers into ai_assistant and exposes the Insights AI Assistant row", async () => {
    const aiReferrers = [
      { referrer: "https://chatgpt.com/c/1", utmMedium: null },
      { referrer: "https://claude.ai/chat/2", utmMedium: null },
      { referrer: "https://perplexity.ai/search/3", utmMedium: null },
      { referrer: "https://gemini.google.com/app", utmMedium: null },
      { referrer: "https://copilot.microsoft.com/chats", utmMedium: null },
      { referrer: "", utmMedium: "ai-assistant" },
    ];

    // Record hourly source visits + first-party WA click events in TenantStore
    for (let i = 0; i < aiReferrers.length; i += 1) {
      const src = aiReferrers[i]!;
      const attr = classifyTrafficAttribution({
        referrer: src.referrer,
        utmMedium: src.utmMedium,
        siteHost: TENANT_CUSTOM_A.customDomain,
      });
      expect(attr.channel).toBe("ai_assistant");

      await alphaDb
        .prepare(
          `INSERT INTO analytics_hourly_sources (hour_bucket, source_bucket, utm_source, visits, updated_at)
           VALUES (?, ?, '', 1, ?)
           ON CONFLICT(hour_bucket, source_bucket, utm_source) DO UPDATE SET
             visits = analytics_hourly_sources.visits + 1,
             updated_at = excluded.updated_at`,
        )
        .bind("2026-11-23T08", attr.hourlySourceBucket, BASE_TIME + i)
        .run();

      const eventRes = await recordFirstPartyEvent(
        alphaDb,
        {
          eventType: "wa_click",
          path: "/tour/umrah-vip",
          sourceCategory: attr.eventSourceCategory,
        },
        { nowMs: BASE_TIME + i },
      );
      expect(eventRes.ok).toBe(true);
    }

    // Record a spoofed referrer (`evil-chatgpt.com`) -> must NOT enter ai_assistant!
    const spoofedAttr = classifyTrafficAttribution({
      referrer: "https://evil-chatgpt.com/fake",
      siteHost: TENANT_CUSTOM_A.customDomain,
    });
    expect(spoofedAttr.channel).toBe("referral");
    await alphaDb
      .prepare(
        `INSERT INTO analytics_hourly_sources (hour_bucket, source_bucket, utm_source, visits, updated_at)
         VALUES (?, ?, '', 2, ?)
         ON CONFLICT(hour_bucket, source_bucket, utm_source) DO UPDATE SET
           visits = analytics_hourly_sources.visits + 2,
           updated_at = excluded.updated_at`,
      )
      .bind("2026-11-23T08", spoofedAttr.hourlySourceBucket, BASE_TIME + 100)
      .run();

    // Persist an AI Assistant lead into TenantStore.leads
    const chatgptLeadAttr = classifyTrafficAttribution({
      referrer: "https://chatgpt.com/c/lead-99",
    });
    const leadRes = await executeIdempotentLeadWrite(alphaDb, {
      idempotencyKey: "t095-ai-lead-1",
      lead: {
        name: "Budi Santoso",
        phoneE164: "+6281234567890",
        message: "Ingin tanya jadwal Umrah Desember",
        sourceCategory: chatgptLeadAttr.channel,
        pagePath: "/tour/umrah-vip",
      },
      nowMs: BASE_TIME + 200,
    });
    expect(leadRes.ok).toBe(true);

    // Load dashboard SEO & Insights snapshot -> verify AI Assistant row counts!
    const snapshot = await loadSeoVisibilitySnapshot({
      platformDb: env.PLATFORM_DB,
      tenantDb: alphaDb,
      tenantId: TENANT_CUSTOM_A.id,
      nowMs: BASE_TIME + 500,
    });
    expect(snapshot).not.toBeNull();
    expect(snapshot?.indexnowEligible).toBe(true);
    expect(snapshot?.indexnowStatusBadge).toBe("Aktif untuk domain khusus");

    const aiRow = snapshot?.channels.find((c) => c.channel === "ai_assistant");
    expect(aiRow).toBeDefined();
    expect(aiRow?.label).toBe("AI Assistant");
    expect(aiRow?.visits).toBe(6);
    expect(aiRow?.leads).toBe(1);
    expect(aiRow?.waClicks).toBeGreaterThan(0);

    const referralRow = snapshot?.channels.find((c) => c.channel === "referral");
    expect(referralRow?.visits).toBe(2);
    expect(referralRow?.leads).toBe(0);
  });

  it("enqueues seo.indexnow_ping from real CMS page/post/offering publish endpoints on verified custom domains, skips .situsku.click trials, and never fails publish on queue error", async () => {
    const pDb = createSqliteDrizzle(env.PLATFORM_DB, platformSchema);
    const ownerUserId = "usr_t095_cms_owner";
    const nowDate = new Date(BASE_TIME);

    await pDb
      .insert(users)
      .values({
        id: ownerUserId,
        name: "Owner T095 CMS",
        email: "owner.t095.cms@example.test",
        emailVerified: true,
        createdAt: nowDate,
        updatedAt: nowDate,
      })
      .onConflictDoNothing();

    for (const [memId, orgId] of [
      ["mem_t095_cms_alpha", TENANT_CUSTOM_A.orgId],
      ["mem_t095_cms_trial", TENANT_TRIAL.orgId],
    ] as const) {
      await pDb
        .insert(members)
        .values({
          id: memId,
          organizationId: orgId,
          userId: ownerUserId,
          role: "owner",
          createdAt: nowDate,
        })
        .onConflictDoNothing();
    }

    // Create draft page, post, and offering on BOTH Alpha (verified custom domain) and Trial (.situsku.click)
    const alphaPage = await createPage(alphaDb, {
      title: "Profil Perusahaan",
      slug: "profil-kami",
      isHomepage: false,
      nowMs: BASE_TIME,
    });
    const alphaPost = await createPost(alphaDb, {
      title: "Tips Umrah 2027",
      slug: "tips-umrah-2027",
      body: {
        schemaVersion: 1,
        blocks: [{ type: "paragraph", text: "Panduan persiapan perjalanan resmi." }],
      },
      nowMs: BASE_TIME,
    });
    const alphaOffering = await createCatalogOffering(
      alphaDb,
      {
        offeringType: "tour",
        title: "Paket Umrah Eksekutif",
        slug: "umrah-eksekutif",
        priceMode: "fixed",
        price: 32_500_000,
        ctaMode: "inquiry",
        attributes: { destination: "Makkah & Madinah", durationDays: 9 },
      },
      { nowMs: BASE_TIME },
    );

    const trialPage = await createPage(trialDb, {
      title: "Profil Trial",
      slug: "profil-trial",
      isHomepage: false,
      nowMs: BASE_TIME,
    });
    const trialPost = await createPost(trialDb, {
      title: "Artikel Trial",
      slug: "artikel-trial-cms",
      body: {
        schemaVersion: 1,
        blocks: [{ type: "paragraph", text: "Konten uji coba." }],
      },
      nowMs: BASE_TIME,
    });
    const trialOffering = await createCatalogOffering(
      trialDb,
      {
        offeringType: "product",
        title: "Produk Trial",
        slug: "produk-trial",
        priceMode: "fixed",
        price: 150_000,
        ctaMode: "inquiry",
        attributes: {},
      },
      { nowMs: BASE_TIME },
    );

    const sentMessages: JobQueuePayload[] = [];
    const queue = {
      async send(msg: JobQueuePayload) {
        sentMessages.push(msg);
      },
    };
    const commonEnv = {
      APP_ENV: "test",
      PLATFORM_DOMAIN: "punyasitus.com",
      SAAS_ZONE: "situsku.click",
      PLATFORM_DB: env.PLATFORM_DB,
      TENANT_STORE: env.TENANT_STORE as unknown as TenantStoreNamespaceLike,
      JOBS_QUEUE: queue,
    };

    const makePublishReq = (pathname: string, version: number) =>
      new Request(`https://app.punyasitus.com${pathname}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://app.punyasitus.com",
        },
        body: JSON.stringify({ version }),
      });

    // 1. Publish Page, Post, and Offering on Alpha (verified custom domain) -> 3 IndexNow pings enqueued!
    const alphaPageRes = await handleTenantPagePublishRequest(
      TENANT_CUSTOM_A.id,
      String(alphaPage.id),
      makePublishReq(`/api/tenants/${TENANT_CUSTOM_A.id}/pages/${alphaPage.id}/publish`, alphaPage.version),
      commonEnv,
      { authenticatedUser: { id: ownerUserId }, nowMs: BASE_TIME + 1_000 },
    );
    expect(alphaPageRes.status).toBe(200);

    const alphaPostRes = await handleTenantPostPublishRequest(
      TENANT_CUSTOM_A.id,
      String(alphaPost.id),
      makePublishReq(`/api/tenants/${TENANT_CUSTOM_A.id}/posts/${alphaPost.id}/publish`, alphaPost.version),
      commonEnv,
      { authenticatedUser: { id: ownerUserId }, nowMs: BASE_TIME + 2_000 },
    );
    expect(alphaPostRes.status).toBe(200);

    const alphaOffRes = await handleTenantCatalogOfferingPublishRequest(
      TENANT_CUSTOM_A.id,
      String(alphaOffering.id),
      makePublishReq(
        `/api/tenants/${TENANT_CUSTOM_A.id}/catalog/${alphaOffering.id}/publish`,
        alphaOffering.version,
      ),
      commonEnv,
      { authenticatedUser: { id: ownerUserId }, nowMs: BASE_TIME + 3_000 },
    );
    expect(alphaOffRes.status).toBe(200);

    expect(sentMessages).toHaveLength(3);
    expect(sentMessages.every((m) => m.topic === "seo.indexnow_ping")).toBe(true);
    expect(sentMessages.map((m) => (m.payload?.urls as string[])?.[0])).toEqual([
      `https://${TENANT_CUSTOM_A.customDomain}/profil-kami`,
      `https://${TENANT_CUSTOM_A.customDomain}/blog/tips-umrah-2027`,
      `https://${TENANT_CUSTOM_A.customDomain}/tour/umrah-eksekutif`,
    ]);

    // 2. Publish Page, Post, and Offering on Trial (.situsku.click) -> 0 IndexNow pings enqueued!
    const beforeTrialCount = sentMessages.length;
    expect(
      (
        await handleTenantPagePublishRequest(
          TENANT_TRIAL.id,
          String(trialPage.id),
          makePublishReq(`/api/tenants/${TENANT_TRIAL.id}/pages/${trialPage.id}/publish`, trialPage.version),
          commonEnv,
          { authenticatedUser: { id: ownerUserId }, nowMs: BASE_TIME + 4_000 },
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await handleTenantPostPublishRequest(
          TENANT_TRIAL.id,
          String(trialPost.id),
          makePublishReq(`/api/tenants/${TENANT_TRIAL.id}/posts/${trialPost.id}/publish`, trialPost.version),
          commonEnv,
          { authenticatedUser: { id: ownerUserId }, nowMs: BASE_TIME + 5_000 },
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await handleTenantCatalogOfferingPublishRequest(
          TENANT_TRIAL.id,
          String(trialOffering.id),
          makePublishReq(
            `/api/tenants/${TENANT_TRIAL.id}/catalog/${trialOffering.id}/publish`,
            trialOffering.version,
          ),
          commonEnv,
          { authenticatedUser: { id: ownerUserId }, nowMs: BASE_TIME + 6_000 },
        )
      ).status,
    ).toBe(200);
    expect(sentMessages.length).toBe(beforeTrialCount);

    // 3. Throwing JOBS_QUEUE.send NEVER fails a committed CMS publish
    const page2 = await createPage(alphaDb, {
      title: "Halaman Tahan Gangguan",
      slug: "tahan-gangguan",
      isHomepage: false,
      nowMs: BASE_TIME + 7_000,
    });
    const resilientRes = await handleTenantPagePublishRequest(
      TENANT_CUSTOM_A.id,
      String(page2.id),
      makePublishReq(`/api/tenants/${TENANT_CUSTOM_A.id}/pages/${page2.id}/publish`, page2.version),
      {
        ...commonEnv,
        JOBS_QUEUE: {
          async send() {
            throw new Error("Simulated queue outage");
          },
        },
      },
      { authenticatedUser: { id: ownerUserId }, nowMs: BASE_TIME + 8_000 },
    );
    expect(resilientRes.status).toBe(200);
  });

  it("fails closed when custom domain lacks verified_at and returns 403 SUBSCRIPTION_LOCKED on locked tenant SEO API mutations", async () => {
    // 1. Seed an active paid tenant whose custom domain has verified_at = NULL -> must fail closed!
    const unverifiedTenantId = "01JT095V000000000000000005";
    const unverifiedOrgId = "org_t095_unverified";
    const unverifiedHost = "www.t095-unverified.id";
    const now = new Date(BASE_TIME);
    const pDb = createSqliteDrizzle(env.PLATFORM_DB, platformSchema);

    await pDb
      .insert(organizations)
      .values({ id: unverifiedOrgId, name: "Unverified Co", slug: "t095-unver", createdAt: now, updatedAt: now })
      .onConflictDoNothing();
    await pDb
      .insert(tenants)
      .values({
        id: unverifiedTenantId,
        organizationId: unverifiedOrgId,
        handle: "t095-unver",
        name: "Unverified Co",
        status: "active",
        paidThrough: new Date(BASE_TIME + 30 * DAY_MS),
        cacheVersion: 1,
        schemaVersion: 0,
        version: 1,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();
    await pDb
      .insert(tenantHosts)
      .values({
        host: unverifiedHost,
        tenantId: unverifiedTenantId,
        kind: "custom",
        status: "active",
        sslStatus: "active",
        isPrimary: true,
        verifiedAt: null,
        version: 1,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();

    const tenantStoreNs = env.TENANT_STORE as unknown as TenantStoreNamespaceLike;
    const unverStub = openTenantStoreStub(tenantStoreNs, unverifiedTenantId);
    await orchestrateTenantMigration(env.PLATFORM_DB, unverStub, unverifiedTenantId, TENANT_MIGRATIONS);
    const unverDb = createTenantDb(unverStub);
    const unverKey = (await ensureTenantIndexNowKey(unverDb, { nowMs: BASE_TIME })).key;

    const keyRes = await handleIndexNowKeyRequest(
      new Request(`https://${unverifiedHost}/${unverKey}.txt`),
      unverKey,
      makeDiscoveryDeps(),
    );
    expect(keyRes.status).toBe(404);

    const enqueueUnver = await enqueueIndexNowPublishPing(
      {
        PLATFORM_DB: env.PLATFORM_DB,
        JOBS_QUEUE: { async send() {} },
        tenantDb: unverDb,
      },
      {
        tenantId: unverifiedTenantId,
        urls: ["/"],
        source: "cms",
        nowMs: BASE_TIME,
      },
    );
    expect(enqueueUnver.enqueued).toBe(false);

    // 2. Seed a locked tenant (paidThrough = H-5 -> effective status = "locked") and verify 403 SUBSCRIPTION_LOCKED on POST /dashboard/[handle]/seo/api
    const lockedNowMs = Date.now();
    const lockedNow = new Date(lockedNowMs);
    const lockedTenantId = "01JT095K000000000000000006";
    const lockedOrgId = "org_t095_locked";
    const lockedHandle = "t095-locked";
    await pDb
      .insert(organizations)
      .values({ id: lockedOrgId, name: "Locked Corp", slug: lockedHandle, createdAt: lockedNow, updatedAt: lockedNow })
      .onConflictDoNothing();
    await pDb
      .insert(tenants)
      .values({
        id: lockedTenantId,
        organizationId: lockedOrgId,
        handle: lockedHandle,
        name: "Locked Corp",
        status: "locked",
        paidThrough: new Date(lockedNowMs - 5 * DAY_MS),
        cacheVersion: 1,
        schemaVersion: 0,
        version: 1,
        createdAt: lockedNow,
        updatedAt: lockedNow,
      })
      .onConflictDoNothing();
    await pDb
      .insert(tenantHosts)
      .values({
        host: `${lockedHandle}.situsku.click`,
        tenantId: lockedTenantId,
        kind: "subdomain",
        status: "active",
        sslStatus: "active",
        isPrimary: true,
        verifiedAt: lockedNow,
        version: 1,
        createdAt: lockedNow,
        updatedAt: lockedNow,
      })
      .onConflictDoNothing();

    const auth = createAuth(env.PLATFORM_DB, {
      baseURL: "https://app.punyasitus.com",
      secret: "local-dev-app-punyasitus-auth-secret-0123456789abcdef",
      surface: "app",
      trustedOrigins: ["https://app.punyasitus.com"],
    });
    const signUpRes = await auth.handler(
      new Request("https://app.punyasitus.com/api/auth/sign-up/email", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://app.punyasitus.com",
        },
        body: JSON.stringify({
          email: "locked.owner.t095@example.test",
          password: "LockedOwnerPassword!123",
          name: "Locked Owner",
        }),
      }),
    );
    expect(signUpRes.status).toBe(200);
    const setCookie = signUpRes.headers.get("set-cookie") ?? "";
    const cookiePair = setCookie.split(";")[0] ?? "";
    const signUpBody = (await signUpRes.json()) as { readonly user?: { readonly id?: string } };
    const lockedUserId = signUpBody.user?.id ?? "";
    expect(lockedUserId.length).toBeGreaterThan(0);

    await pDb
      .insert(members)
      .values({
        id: "mem_t095_locked_owner",
        organizationId: lockedOrgId,
        userId: lockedUserId,
        role: "owner",
        createdAt: lockedNow,
      })
      .onConflictDoNothing();

    const lockedMutationRes = await handleSeoVisibilityApiRequest(
      lockedHandle,
      new Request(`https://app.punyasitus.com/dashboard/${lockedHandle}/seo/api`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://app.punyasitus.com",
          Cookie: cookiePair,
        },
        body: JSON.stringify({
          action: "update-ai-training-policy",
          aiTrainingPolicy: "disallow",
        }),
      }),
      {
        APP_ENV: "test",
        PLATFORM_DOMAIN: "punyasitus.com",
        SAAS_ZONE: "situsku.click",
        PLATFORM_DB: env.PLATFORM_DB,
        TENANT_STORE: tenantStoreNs,
      },
      { nowMs: lockedNowMs },
    );

    expect(lockedMutationRes.status).toBe(403);
    const lockedBody = (await lockedMutationRes.json()) as {
      readonly success?: boolean;
      readonly code?: string;
    };
    expect(lockedBody.success).toBe(false);
    expect(lockedBody.code).toBe("SUBSCRIPTION_LOCKED");
  });
});

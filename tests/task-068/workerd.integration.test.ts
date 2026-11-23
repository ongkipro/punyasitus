import { createMessageBatch } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { APP_SESSION_COOKIE_NAME } from "@punyasitus/auth";
import {
  DAY_MS,
  HOLD_RELEASE_MIN_REMAINING_MS,
  PAID_DELETION_WINDOW_MS,
  TRIAL_DELETION_WINDOW_MS,
  UNPAID_NO_TRIAL_DELETION_WINDOW_MS,
  BillingConflictError,
} from "@punyasitus/core/billing/index";
import { createLocalMailSink } from "@punyasitus/core/email/index";
import {
  applyBillingObligationsMigration,
  beginDurablePaymentAttempt,
  InvalidLifecycleStateError,
  setOperatorManualHold,
  settleVerifiedPaymentAttempt,
} from "@punyasitus/db/billing/index";
import {
  applyBillingCouponsMigration,
  beginDurablePaymentAttemptWithCoupon,
  createPromoCoupon,
} from "@punyasitus/db/billing/coupons/index";
import { applyBillingReceiptsMigration } from "@punyasitus/db/billing/receipts/index";
import {
  applyPlatformMigrations,
  createTenantDb,
  openTenantStoreStub,
  orchestrateTenantMigration,
  type TenantStoreNamespaceLike,
} from "@punyasitus/db/connections";
import { applyEmailClaimsMigration } from "@punyasitus/db/email/index";
import {
  applyTenantOffboardingMigration,
  claimTenantForOffboarding,
  executeTenantOffboardingPurge,
  getTenantOffboardingRun,
  listOffboardingWarningsForDeadline,
  listTenantsForOffboardingSweep,
  purgeTenantStoreData,
  replayOffboardingTombstonesFull,
  resetInMemoryLeadsExportRateLimits,
  type OffboardingCloudflareClientLike,
  type OffboardingR2BucketLike,
  type OffboardingTenantStoreNamespaceLike,
  type OffboardingTenantStoreStubLike,
} from "@punyasitus/db/offboarding/index";
import { PLATFORM_MIGRATIONS } from "@punyasitus/db/platform";
import { checkHandleAvailability } from "@punyasitus/db/provisioning/self-service";
import { clearHostResolutionCache } from "@punyasitus/db/routing/index";
import { TENANT_MIGRATIONS } from "@punyasitus/db/tenant";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  executeAuthMiddleware,
  type AuthMiddlewareLocals,
  type AuthRuntimeEnv,
} from "../../apps/web/src/middleware/auth.ts";
import { handleBetterAuthRequest } from "../../apps/web/src/pages/api/auth/[...all].ts";
import { handleTenantLeadsExportCsvRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/leads/export.csv.ts";
import { handleTenantLeadsExportRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/leads/export.ts";
import { handleTenantLeadsListRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/leads/index.ts";
import { handleTenantLeadDetailRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/leads/[leadId].ts";
import {
  DEFAULT_CRON_EXPRESSION,
  DEFAULT_CRON_JOB_DEFINITIONS,
  dispatchScheduledCron,
} from "../../apps/web/src/worker/cron/index.ts";
import {
  processDurableQueueBatch,
} from "../../apps/web/src/worker/queues/index.ts";
import {
  OFFBOARDING_CRON_JOB_DEFINITIONS,
  createOffboardingJobRegistry,
  runTenantOffboardingSweep,
} from "../../apps/web/src/worker/queues/offboarding/index.ts";
import {
  TENANT_OFFBOARDING_PURGE_TOPIC,
  TENANT_OFFBOARDING_SWEEP_TOPIC,
} from "../../apps/web/src/worker/queues/dispatch/offboarding.ts";
import {
  createRetentionJobRegistry,
  RETENTION_SWEEP_TOPIC,
} from "../../apps/web/src/worker/queues/retention/index.ts";
import {
  runDailyPlatformBackup,
  runIsolatedRestoreDrill,
} from "../../scripts/backup-restore/index.ts";

const APP_ORIGIN = "https://app.punyasitus.com";
const TEST_APP_SECRET = "test-t068-app-auth-secret-0123456789abcdef0123456789abcdef";
const TEST_CONSOLE_SECRET = "test-t068-console-auth-secret-fedcba9876543210fedcba9876543210";

function buildAuthEnv(): AuthRuntimeEnv {
  return {
    APP_ENV: "test",
    PLATFORM_DOMAIN: "punyasitus.com",
    PLATFORM_DB: env.PLATFORM_DB,
    AUTH_SECRET: TEST_APP_SECRET,
    CONSOLE_AUTH_SECRET: TEST_CONSOLE_SECRET,
  };
}

function createMiddlewareLocals(surface: "app" | "console" = "app"): AuthMiddlewareLocals {
  return {
    surface,
    host: surface === "app" ? "app.punyasitus.com" : "console.punyasitus.com",
    isLocalLoopback: false,
    tenant: null,
    tenantDb: null,
    authUser: null,
    authSession: null,
    authorizedTenantMember: null,
    tenantEntitlement: null,
    platformOperator: null,
    twoFactorVerifiedAtMs: null,
  };
}

function getSetCookies(headers: Headers): string[] {
  const h = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof h.getSetCookie === "function") return h.getSetCookie();
  const raw = headers.get("set-cookie");
  return raw ? [raw] : [];
}

function extractSessionCookie(res: Response): string {
  const pair = getSetCookies(res.headers).find((c) => c.startsWith(`${APP_SESSION_COOKIE_NAME}=`));
  if (!pair) throw new Error("Missing app session cookie");
  return (pair.split(";")[0] ?? "").trim();
}

async function signUpUser(email: string, name: string): Promise<{ userId: string; cookie: string }> {
  const req = new Request(`${APP_ORIGIN}/api/auth/sign-up/email`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: APP_ORIGIN,
    },
    body: JSON.stringify({ email, password: "StrongPassword!2026", name }),
  });
  const res = await handleBetterAuthRequest(req, buildAuthEnv());
  expect(res.status).toBe(200);
  const data = (await res.json()) as { user?: { id: string } };
  const userId = data.user?.id;
  if (!userId) throw new Error("Missing userId from signup");
  return { userId, cookie: extractSessionCookie(res) };
}

function makeAdminRequest(
  pathname: string,
  method = "GET",
  cookie?: string,
  body?: unknown,
): Request {
  const headers = new Headers();
  if (cookie) headers.set("Cookie", cookie);
  if (method !== "GET" && method !== "HEAD") {
    headers.set("Origin", APP_ORIGIN);
    headers.set("Content-Type", "application/json");
  }
  return new Request(`${APP_ORIGIN}${pathname}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

function createInMemoryR2Bucket(opts?: {
  readonly onDelete?: (keys: readonly string[]) => Promise<void> | void;
}): OffboardingR2BucketLike & {
  put(key: string, value: string): Promise<void>;
  get(key: string): Promise<{ text(): Promise<string> } | null>;
  head(key: string): Promise<{ readonly key: string; readonly size: number } | null>;
  keys(): string[];
} {
  const store = new Map<string, { body: string; uploaded: Date }>();
  return {
    async put(key: string, value: string) {
      store.set(key, { body: value, uploaded: new Date() });
    },
    async get(key: string) {
      const item = store.get(key);
      if (!item) return null;
      return {
        async text() {
          return item.body;
        },
      };
    },
    async head(key: string) {
      const item = store.get(key);
      return item ? { key, size: item.body.length } : null;
    },
    async list(options?: R2ListOptions) {
      const prefix = options?.prefix ?? "";
      const objects = [...store.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([key, item]) => ({
          key,
          size: item.body.length,
          uploaded: item.uploaded,
          customMetadata: {},
        })) as unknown as R2Object[];
      return {
        objects,
        truncated: false,
        delimitedPrefixes: [],
      } as R2Objects;
    },
    async delete(keys: string | string[]) {
      const list = Array.isArray(keys) ? keys : [keys];
      if (opts?.onDelete) {
        await opts.onDelete(list);
      }
      for (const k of list) {
        store.delete(k);
      }
    },
    keys() {
      return [...store.keys()].sort();
    },
  };
}

function createTrackedTenantStoreNamespace(
  realNs: TenantStoreNamespaceLike,
  opts?: {
    readonly onDeleteAll?: (tenantId: string) => Promise<void> | void;
  },
): {
  readonly namespace: OffboardingTenantStoreNamespaceLike;
  readonly deleteAlarmCalls: string[];
  readonly deleteAllCalls: string[];
} {
  const deleteAlarmCalls: string[] = [];
  const deleteAllCalls: string[] = [];

  const namespace: OffboardingTenantStoreNamespaceLike = {
    getByName(tenantId: string, options?: { locationHint?: string }): OffboardingTenantStoreStubLike {
      const realStub = realNs.getByName(tenantId, options);
      return {
        query: (protocol, statement, raw) =>
          realStub.query(protocol, statement as Parameters<typeof realStub.query>[1], raw),
        batch: (protocol, statements) =>
          realStub.batch(protocol, statements as Parameters<typeof realStub.batch>[1]),
        schemaState: (protocol) => realStub.schemaState(protocol),
        async deleteAlarm() {
          deleteAlarmCalls.push(tenantId);
        },
        async deleteAll() {
          if (opts?.onDeleteAll) {
            await opts.onDeleteAll(tenantId);
          }
          deleteAllCalls.push(tenantId);
          // Physically wipe all SQLite tables inside the real TenantStore DO!
          const tenantDb = createTenantDb(realStub);
          const tablesRes = await tenantDb
            .prepare(
              "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
            )
            .all<{ readonly name: string }>();
          const stmts = [
            tenantDb.prepare("PRAGMA foreign_keys = OFF"),
            ...(tablesRes.results ?? [])
              .filter((r) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(r.name))
              .map((r) => tenantDb.prepare(`DELETE FROM "${r.name}"`)),
            tenantDb.prepare("PRAGMA foreign_keys = ON"),
          ];
          await tenantDb.batch(stmts);
        },
      };
    },
  };

  return { namespace, deleteAlarmCalls, deleteAllCalls };
}

function createMockCloudflareClient(opts?: {
  readonly onDelete?: (id: string) => Promise<void> | void;
}): OffboardingCloudflareClientLike & { readonly deletedIds: string[] } {
  const deletedIds: string[] = [];
  return {
    deletedIds,
    async deleteCustomHostname(customHostnameId: string) {
      if (opts?.onDelete) {
        await opts.onDelete(customHostnameId);
      }
      deletedIds.push(customHostnameId);
      return { deleted: true, alreadyAbsent: false };
    },
  };
}

let seq = 0;
function uid(prefix: string): string {
  seq += 1;
  return `${prefix}${String(seq).padStart(4, "0")}`;
}

async function seedTenantFixture(params: {
  readonly handle: string;
  readonly name: string;
  readonly status: "trial" | "active" | "grace" | "locked" | "suspended";
  readonly ownerEmail: string;
  readonly trialEndsAtMs?: number | null;
  readonly paidThroughMs?: number | null;
  readonly deletionDueAtMs?: number | null;
  readonly createdAtMs: number;
  readonly customHost?: { readonly host: string; readonly cfId: string } | null;
  readonly seedTenantStore?: boolean;
}): Promise<{
  readonly tenantId: string;
  readonly orgId: string;
  readonly ownerUserId: string;
  readonly ownerCookie: string;
  readonly handle: string;
}> {
  const tenantId = `01T068TENANT${String(++seq).padStart(14, "0")}`;
  const orgId = `01T068ORG${String(++seq).padStart(17, "0")}`;
  const owner = await signUpUser(params.ownerEmail, `Owner ${params.name}`);

  await env.PLATFORM_DB.batch([
    env.PLATFORM_DB.prepare(
      `INSERT INTO organizations (id, name, slug, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(orgId, params.name, params.handle, params.createdAtMs, params.createdAtMs),
    env.PLATFORM_DB.prepare(
      `INSERT INTO members (id, organization_id, user_id, role, created_at)
       VALUES (?, ?, ?, 'owner', ?)`,
    ).bind(uid("mem_"), orgId, owner.userId, params.createdAtMs),
    env.PLATFORM_DB.prepare(
      `INSERT INTO tenants (
         id, organization_id, handle, name, vertical, status,
         operator_hold, trial_ends_at, paid_through, deletion_due_at,
         retention_paused_at, offboarding_started_at,
         cache_version, schema_version, version, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'compro', ?, 0, ?, ?, ?, NULL, NULL, 1, 1, 1, ?, ?)`,
    ).bind(
      tenantId,
      orgId,
      params.handle,
      params.name,
      params.status,
      params.trialEndsAtMs ?? null,
      params.paidThroughMs ?? null,
      params.deletionDueAtMs ?? null,
      params.createdAtMs,
      params.createdAtMs,
    ),
    env.PLATFORM_DB.prepare(
      `INSERT INTO tenant_hosts (
         host, tenant_id, kind, cf_custom_hostname_id, status, ssl_status,
         is_primary, version, created_at, updated_at
       ) VALUES (?, ?, 'subdomain', NULL, 'active', 'active', ?, 1, ?, ?)`,
    ).bind(
      `${params.handle}.situsku.click`,
      tenantId,
      params.customHost ? 0 : 1,
      params.createdAtMs,
      params.createdAtMs,
    ),
  ]);

  if (params.customHost) {
    await env.PLATFORM_DB.prepare(
      `INSERT INTO tenant_hosts (
         host, tenant_id, kind, cf_custom_hostname_id, status, ssl_status,
         is_primary, version, created_at, updated_at
       ) VALUES (?, ?, 'custom', ?, 'active', 'active', 1, 1, ?, ?)`,
    )
      .bind(
        params.customHost.host,
        tenantId,
        params.customHost.cfId,
        params.createdAtMs,
        params.createdAtMs,
      )
      .run();
  }

  if (params.seedTenantStore !== false) {
    const ns = env.TENANT_STORE as unknown as TenantStoreNamespaceLike;
    const stub = openTenantStoreStub(ns, tenantId);
    await orchestrateTenantMigration(env.PLATFORM_DB, stub, tenantId, TENANT_MIGRATIONS, {
      now: () => params.createdAtMs,
    });
    const tenantDb = createTenantDb(stub);
    await tenantDb.batch([
      tenantDb
        .prepare(
          `INSERT INTO pages (slug, title, status, draft_sections_json, published_sections_json, version, created_at, updated_at)
           VALUES ('beranda', 'Beranda', 'published', '[]', '[]', 1, ?, ?)`,
        )
        .bind(params.createdAtMs, params.createdAtMs),
      tenantDb
        .prepare(
          `INSERT INTO leads (name, phone_e164, email, message, source_category, status, version, created_at, updated_at)
           VALUES ('Prospek Uji', '+6281234567890', 'lead@example.com', 'Halo saya tertarik', 'direct', 'new', 1, ?, ?)`,
        )
        .bind(params.createdAtMs, params.createdAtMs),
    ]);
  }

  return {
    tenantId,
    orgId,
    ownerUserId: owner.userId,
    ownerCookie: owner.cookie,
    handle: params.handle,
  };
}

function buildQueueBatch(messages: readonly { id: string; body: unknown }[]) {
  const rawBatch = createMessageBatch(
    "punyasitus-jobs-test",
    messages.map((m) => ({
      id: m.id,
      timestamp: new Date(),
      body: m.body,
      attempts: 1,
    })),
  );
  const acked = new Set<string>();
  const retried = new Set<string>();
  const wrapped = rawBatch.messages.map((msg) => ({
    id: msg.id,
    timestamp: msg.timestamp,
    body: msg.body,
    attempts: msg.attempts,
    ack() {
      acked.add(msg.id);
      msg.ack();
    },
    retry(opts?: { delaySeconds?: number }) {
      retried.add(msg.id);
      msg.retry(opts);
    },
  }));
  return {
    batch: {
      queue: rawBatch.queue,
      messages: wrapped,
      ackAll: () => rawBatch.ackAll(),
      retryAll: () => rawBatch.retryAll(),
    } as unknown as MessageBatch<unknown>,
    acked,
    retried,
  };
}

describe("TASK-068 workerd integration: Locked-Tenant Retention, Leads Export & Serialized Offboarding", () => {
  beforeAll(async () => {
    await applyPlatformMigrations(env.PLATFORM_DB, PLATFORM_MIGRATIONS);
    await applyEmailClaimsMigration(env.PLATFORM_DB);
    await applyBillingObligationsMigration(env.PLATFORM_DB);
    await applyBillingReceiptsMigration(env.PLATFORM_DB);
    await applyBillingCouponsMigration(env.PLATFORM_DB);
    await applyTenantOffboardingMigration(env.PLATFORM_DB);
  });

  beforeEach(() => {
    clearHostResolutionCache();
    resetInMemoryLeadsExportRateLimits();
  });

  it("enforces exact frozen-time deletion_due_at & warning schedules for never-paid trial (+30d), no-trial unpaid (+30d), and previously paid (H+45) regardless of scheduler delay", async () => {
    const baseMs = Date.UTC(2026, 4, 1, 0, 0, 0);
    const mailSink = createLocalMailSink();
    const r2 = createInMemoryR2Bucket();
    const cf = createMockCloudflareClient();
    const realNs = env.TENANT_STORE as unknown as TenantStoreNamespaceLike;
    const trackedNs = createTrackedTenantStoreNamespace(realNs);

    // 1. Never-paid trial (status still 'trial' to prove scheduler-delay independence!)
    const trialEnds = baseMs + 7 * DAY_MS;
    const trialTenant = await seedTenantFixture({
      handle: "t068-trial-unpaid",
      name: "Trial Unpaid Co",
      status: "trial",
      ownerEmail: "owner-trial-68@example.com",
      trialEndsAtMs: trialEnds,
      paidThroughMs: null,
      createdAtMs: baseMs,
    });
    await r2.put(`t/${trialTenant.tenantId}/media/hero.webp`, "trial-img");

    // 2. No-trial unpaid site (provisioning created_at + 30d)
    const noTrialTenant = await seedTenantFixture({
      handle: "t068-notrial-unpaid",
      name: "No Trial Unpaid Co",
      status: "suspended",
      ownerEmail: "owner-notrial-68@example.com",
      trialEndsAtMs: null,
      paidThroughMs: null,
      createdAtMs: baseMs,
    });
    await r2.put(`t/${noTrialTenant.tenantId}/media/logo.webp`, "notrial-img");

    // 3. Previously paid website (status still 'active' to prove H+45 regardless of scheduler delay!)
    const paidThrough = baseMs + 10 * DAY_MS;
    const paidTenant = await seedTenantFixture({
      handle: "t068-paid-overdue",
      name: "Paid Overdue Co",
      status: "active",
      ownerEmail: "owner-paid-68@example.com",
      trialEndsAtMs: null,
      paidThroughMs: paidThrough,
      createdAtMs: baseMs - 20 * DAY_MS,
      customHost: { host: "www.paid-overdue-68.example.id", cfId: "cf_ch_paid_68" },
    });
    await r2.put(`t/${paidTenant.tenantId}/media/banner.webp`, "paid-img");

    // 4. Control Tenant B (active paid, must NEVER be touched!)
    const controlTenant = await seedTenantFixture({
      handle: "t068-control-b",
      name: "Control Active Co",
      status: "active",
      ownerEmail: "owner-control-68@example.com",
      paidThroughMs: baseMs + 180 * DAY_MS,
      createdAtMs: baseMs,
      customHost: { host: "www.control-b-68.example.id", cfId: "cf_ch_ctrl_68" },
    });
    await r2.put(`t/${controlTenant.tenantId}/media/safe.webp`, "safe-img");

    // --- Test trial warning schedule (-7d, -3d, -1d) and exact deduplication ---
    const trialDue = trialEnds + TRIAL_DELETION_WINDOW_MS;
    await runTenantOffboardingSweep(env, {
      nowMs: trialDue - 7 * DAY_MS,
      tenantId: trialTenant.tenantId,
      emailPort: mailSink,
      cloudflareClient: cf,
      mediaBucket: r2,
      tenantStoreNamespace: trackedNs.namespace,
    });
    // Re-running on same day must deduplicate!
    await runTenantOffboardingSweep(env, {
      nowMs: trialDue - 7 * DAY_MS + 3600_000,
      tenantId: trialTenant.tenantId,
      emailPort: mailSink,
      cloudflareClient: cf,
      mediaBucket: r2,
      tenantStoreNamespace: trackedNs.namespace,
    });
    await runTenantOffboardingSweep(env, {
      nowMs: trialDue - 3 * DAY_MS,
      tenantId: trialTenant.tenantId,
      emailPort: mailSink,
      cloudflareClient: cf,
      mediaBucket: r2,
      tenantStoreNamespace: trackedNs.namespace,
    });
    await runTenantOffboardingSweep(env, {
      nowMs: trialDue - 1 * DAY_MS,
      tenantId: trialTenant.tenantId,
      emailPort: mailSink,
      cloudflareClient: cf,
      mediaBucket: r2,
      tenantStoreNamespace: trackedNs.namespace,
    });

    const trialEmails = mailSink.findByRecipient("owner-trial-68@example.com");
    expect(trialEmails).toHaveLength(3);

    // 1 second before trial deletion_due_at -> NOTHING deleted!
    const trialBefore = await runTenantOffboardingSweep(env, {
      nowMs: trialDue - 1000,
      tenantId: trialTenant.tenantId,
      emailPort: mailSink,
      cloudflareClient: cf,
      mediaBucket: r2,
      tenantStoreNamespace: trackedNs.namespace,
    });
    expect(trialBefore.tenantsPurged).toBe(0);
    expect(await r2.head(`t/${trialTenant.tenantId}/media/hero.webp`)).not.toBeNull();

    // At trial deletion_due_at -> purged!
    const trialAtDue = await runTenantOffboardingSweep(env, {
      nowMs: trialDue,
      tenantId: trialTenant.tenantId,
      emailPort: mailSink,
      cloudflareClient: cf,
      mediaBucket: r2,
      tenantStoreNamespace: trackedNs.namespace,
    });
    expect(trialAtDue.tenantsPurged).toBe(1);
    expect(await r2.head(`t/${trialTenant.tenantId}/media/hero.webp`)).toBeNull();
    expect(trackedNs.deleteAlarmCalls).toContain(trialTenant.tenantId);
    expect(trackedNs.deleteAllCalls).toContain(trialTenant.tenantId);

    // --- Test no-trial unpaid (created_at + 30d): -1s safe, 0s purged ---
    const noTrialDue = baseMs + UNPAID_NO_TRIAL_DELETION_WINDOW_MS;
    const noTrialBefore = await runTenantOffboardingSweep(env, {
      nowMs: noTrialDue - 1000,
      tenantId: noTrialTenant.tenantId,
      emailPort: mailSink,
      cloudflareClient: cf,
      mediaBucket: r2,
      tenantStoreNamespace: trackedNs.namespace,
    });
    expect(noTrialBefore.tenantsPurged).toBe(0);
    expect(await r2.head(`t/${noTrialTenant.tenantId}/media/logo.webp`)).not.toBeNull();

    const noTrialAtDue = await runTenantOffboardingSweep(env, {
      nowMs: noTrialDue,
      tenantId: noTrialTenant.tenantId,
      emailPort: mailSink,
      cloudflareClient: cf,
      mediaBucket: r2,
      tenantStoreNamespace: trackedNs.namespace,
    });
    expect(noTrialAtDue.tenantsPurged).toBe(1);
    expect(await r2.head(`t/${noTrialTenant.tenantId}/media/logo.webp`)).toBeNull();

    // --- Test previously paid (H+45, warnings H+38, H+42, H+44) ---
    const paidDue = paidThrough + PAID_DELETION_WINDOW_MS;
    for (const dayOffset of [38, 42, 44]) {
      await runTenantOffboardingSweep(env, {
        nowMs: paidThrough + dayOffset * DAY_MS,
        tenantId: paidTenant.tenantId,
        emailPort: mailSink,
        cloudflareClient: cf,
        mediaBucket: r2,
        tenantStoreNamespace: trackedNs.namespace,
      });
    }
    const paidEmails = mailSink.findByRecipient("owner-paid-68@example.com");
    expect(paidEmails).toHaveLength(3);
    expect(paidEmails[0]?.subject).toContain("H+38");
    expect(paidEmails[1]?.subject).toContain("H+42");
    expect(paidEmails[2]?.subject).toContain("H+44");

    // 1 second before H+45 -> nothing deleted!
    const paidBefore = await runTenantOffboardingSweep(env, {
      nowMs: paidDue - 1000,
      tenantId: paidTenant.tenantId,
      emailPort: mailSink,
      cloudflareClient: cf,
      mediaBucket: r2,
      tenantStoreNamespace: trackedNs.namespace,
    });
    expect(paidBefore.tenantsPurged).toBe(0);
    expect(cf.deletedIds).not.toContain("cf_ch_paid_68");

    // At H+45 -> custom hostnames, R2 objects, TenantStore content/leads ALL deleted!
    const paidAtDue = await runTenantOffboardingSweep(env, {
      nowMs: paidDue,
      tenantId: paidTenant.tenantId,
      emailPort: mailSink,
      cloudflareClient: cf,
      mediaBucket: r2,
      tenantStoreNamespace: trackedNs.namespace,
    });
    expect(paidAtDue.tenantsPurged).toBe(1);
    expect(cf.deletedIds).toEqual(["cf_ch_paid_68"]);
    expect(await r2.head(`t/${paidTenant.tenantId}/media/banner.webp`)).toBeNull();

    const paidStoreDb = createTenantDb(openTenantStoreStub(realNs, paidTenant.tenantId));
    const remainingPages = await paidStoreDb
      .prepare("SELECT COUNT(*) AS cnt FROM pages")
      .first<{ readonly cnt: number }>();
    const remainingLeads = await paidStoreDb
      .prepare("SELECT COUNT(*) AS cnt FROM leads")
      .first<{ readonly cnt: number }>();
    expect(Number(remainingPages?.cnt ?? 0)).toBe(0);
    expect(Number(remainingLeads?.cnt ?? 0)).toBe(0);

    // Control tenant B MUST be 100% untouched!
    expect(await r2.head(`t/${controlTenant.tenantId}/media/safe.webp`)).not.toBeNull();
    expect(cf.deletedIds).not.toContain("cf_ch_ctrl_68");
    const ctrlStoreDb = createTenantDb(openTenantStoreStub(realNs, controlTenant.tenantId));
    const ctrlPages = await ctrlStoreDb
      .prepare("SELECT COUNT(*) AS cnt FROM pages")
      .first<{ readonly cnt: number }>();
    expect(Number(ctrlPages?.cnt ?? 0)).toBe(1);
  });

  it("sends ONLY the latest missed reminder on a delayed job (zero spam burst) and skips reminders + restores data after payment before deadline", async () => {
    const baseMs = Date.UTC(2026, 5, 1, 0, 0, 0);
    const paidThrough = baseMs;
    const mailSink = createLocalMailSink();
    const r2 = createInMemoryR2Bucket();
    const realNs = env.TENANT_STORE as unknown as TenantStoreNamespaceLike;

    // 1. Delayed-job tenant: no sweep ran at H+38 or H+42; wakes at H+44 + 2h
    const delayedTenant = await seedTenantFixture({
      handle: "t068-delayed-warn",
      name: "Delayed Warn Co",
      status: "suspended",
      ownerEmail: "owner-delayed-68@example.com",
      paidThroughMs: paidThrough,
      createdAtMs: baseMs - 30 * DAY_MS,
    });

    const delayedSweep = await runTenantOffboardingSweep(env, {
      nowMs: paidThrough + 44 * DAY_MS + 2 * 3600_000,
      tenantId: delayedTenant.tenantId,
      emailPort: mailSink,
      mediaBucket: r2,
    });
    expect(delayedSweep.warningsSent).toBe(1);
    expect(delayedSweep.warningsSuppressedCatchup).toBe(2);

    const sentDelayed = mailSink.findByRecipient("owner-delayed-68@example.com");
    expect(sentDelayed).toHaveLength(1);
    expect(sentDelayed[0]?.subject).toContain("H+44");

    const warningRows = await listOffboardingWarningsForDeadline(
      env.PLATFORM_DB,
      delayedTenant.tenantId,
      paidThrough + PAID_DELETION_WINDOW_MS,
    );
    const byStage = new Map(warningRows.map((w) => [w.stage, w.outcome]));
    expect(byStage.get("paid_h38")).toBe("suppressed_catchup");
    expect(byStage.get("paid_h42")).toBe("suppressed_catchup");
    expect(byStage.get("paid_h44")).toBe("submitted");

    // 2. Payment before deadline: H+38 sent, then pays at H+40 -> H+42/H+44 skipped & retained data restored!
    const payingTenant = await seedTenantFixture({
      handle: "t068-pay-before-due",
      name: "Pay Before Due Co",
      status: "suspended",
      ownerEmail: "owner-paybefore-68@example.com",
      paidThroughMs: paidThrough,
      createdAtMs: baseMs - 30 * DAY_MS,
    });
    await r2.put(`t/${payingTenant.tenantId}/media/keep.webp`, "retained-photo");

    await runTenantOffboardingSweep(env, {
      nowMs: paidThrough + 38 * DAY_MS,
      tenantId: payingTenant.tenantId,
      emailPort: mailSink,
      mediaBucket: r2,
    });
    expect(mailSink.findByRecipient("owner-paybefore-68@example.com")).toHaveLength(1);

    // Owner pays at H+40!
    const payAtMs = paidThrough + 40 * DAY_MS;
    const begun = await beginDurablePaymentAttempt(env.PLATFORM_DB, {
      tenantId: payingTenant.tenantId,
      effectiveTenantStatus: "suspended",
      payerType: "tenant",
      payerAgencyId: null,
      plan: "monthly",
      channelKind: "QRIS",
      channelCode: "QRIS",
      estimatedChannelFeeIdr: 1500,
      idempotencyKey: `idem-restore-${uid("k")}`,
      requestHash: "hash-restore-68",
      providerAccountId: "default",
      nowMs: payAtMs,
    });
    await env.PLATFORM_DB.prepare(
      "UPDATE payment_attempts SET lifecycle_state = 'pending', state = 'pending', provider_transaction_id = ? WHERE id = ?",
    )
      .bind(`trx_restore_${uid("x")}`, begun.attempt.id)
      .run();

    const settled = await settleVerifiedPaymentAttempt(env.PLATFORM_DB, {
      attemptId: begun.attempt.id,
      obligationId: begun.obligation.id,
      tenantId: payingTenant.tenantId,
      plan: "monthly",
      verifiedAmountIdr: begun.attempt.totalPayableIdr,
      providerTransactionId: `trx_restore_s_${uid("x")}`,
      providerStatus: "SETTLED",
      policyProfile: "autolaris_v1",
      policyVersion: "1",
      settledAtMs: payAtMs,
      reconciledVia: "advice",
      actorUserId: null,
      actorRole: "system",
      nowMs: payAtMs,
    });
    expect(settled.outcome).toBe("settled");

    // Sweep at H+42, H+44, H+45 -> 0 additional warnings, 0 deletion, data intact!
    for (const d of [42, 44, 45]) {
      const sw = await runTenantOffboardingSweep(env, {
        nowMs: paidThrough + d * DAY_MS,
        tenantId: payingTenant.tenantId,
        emailPort: mailSink,
        mediaBucket: r2,
      });
      expect(sw.warningsSent).toBe(0);
      expect(sw.tenantsPurged).toBe(0);
    }
    expect(mailSink.findByRecipient("owner-paybefore-68@example.com")).toHaveLength(1);
    expect(await r2.head(`t/${payingTenant.tenantId}/media/keep.webp`)).not.toBeNull();
    const restoredDb = createTenantDb(openTenantStoreStub(realNs, payingTenant.tenantId));
    const pageCount = await restoredDb
      .prepare("SELECT COUNT(*) AS cnt FROM pages")
      .first<{ readonly cnt: number }>();
    expect(Number(pageCount?.cnt ?? 0)).toBe(1);
  });

  it("purges leads past their 180-day retention while tenant is locked without touching fresh leads or content", async () => {
    const nowMs = Date.UTC(2026, 10, 20, 0, 0, 0);
    const lockedTenant = await seedTenantFixture({
      handle: "t068-locked-lead-ret",
      name: "Locked Lead Retention Co",
      status: "locked",
      ownerEmail: "owner-lockedret-68@example.com",
      paidThroughMs: nowMs - 5 * DAY_MS, // H+5 -> locked
      createdAtMs: nowMs - 220 * DAY_MS,
    });

    const realNs = env.TENANT_STORE as unknown as TenantStoreNamespaceLike;
    const tenantDb = createTenantDb(openTenantStoreStub(realNs, lockedTenant.tenantId));
    // Clear initial seed lead and insert 1 expired (195 days old) + 1 fresh (10 days old)
    await tenantDb.batch([
      tenantDb.prepare("DELETE FROM leads"),
      tenantDb
        .prepare(
          `INSERT INTO leads (name, phone_e164, email, message, source_category, status, version, created_at, updated_at)
           VALUES ('Expired Lead', '+628111111111', 'old@example.com', 'Old inquiry', 'direct', 'new', 1, ?, ?)`,
        )
        .bind(nowMs - 195 * DAY_MS, nowMs - 195 * DAY_MS),
      tenantDb
        .prepare(
          `INSERT INTO leads (name, phone_e164, email, message, source_category, status, version, created_at, updated_at)
           VALUES ('Fresh Lead', '+628222222222', 'fresh@example.com', 'Recent inquiry', 'direct', 'new', 1, ?, ?)`,
        )
        .bind(nowMs - 10 * DAY_MS, nowMs - 10 * DAY_MS),
    ]);

    const { batch } = buildQueueBatch([
      {
        id: "ret-locked-1",
        body: {
          idempotencyKey: `ret-locked-${uid("r")}`,
          topic: RETENTION_SWEEP_TOPIC,
          tenantId: lockedTenant.tenantId,
          payload: { nowMs, replayTombstones: false },
          enqueuedAt: nowMs,
        },
      },
    ]);

    const res = await processDurableQueueBatch(
      batch,
      env,
      createRetentionJobRegistry(),
      { now: () => nowMs },
    );
    expect(res.completed).toBe(1);

    const remaining = await tenantDb
      .prepare("SELECT name FROM leads ORDER BY id ASC")
      .all<{ readonly name: string }>();
    expect(remaining.results.map((r) => r.name)).toEqual(["Fresh Lead"]);
  });

  it("pauses deletion clock under operator hold and resumes with at least 14 days remaining upon release", async () => {
    const paidThrough = Date.UTC(2026, 6, 1, 0, 0, 0);
    const holdTenant = await seedTenantFixture({
      handle: "t068-hold-pause",
      name: "Hold Pause Co",
      status: "suspended",
      ownerEmail: "owner-hold-68@example.com",
      paidThroughMs: paidThrough,
      createdAtMs: paidThrough - 30 * DAY_MS,
    });

    // Apply operator hold at H+43 (only 2 days before H+45!)
    const holdAtMs = paidThrough + 43 * DAY_MS;
    const held = await setOperatorManualHold(env.PLATFORM_DB, {
      tenantId: holdTenant.tenantId,
      hold: true,
      reason: "Peninjauan kepatuhan konten sementara oleh operator",
      operatorUserId: "op_t068_1",
      nowMs: holdAtMs,
    });
    expect(held.operatorHold).toBe(true);
    expect(held.retentionPausedAtMs).toBe(holdAtMs);

    // At H+60 (well past original H+45), offboarding claim MUST be blocked by operator hold!
    const blockedClaim = await claimTenantForOffboarding(env.PLATFORM_DB, {
      tenantId: holdTenant.tenantId,
      nowMs: paidThrough + 60 * DAY_MS,
    });
    expect(blockedClaim.claimed).toBe(false);
    if (!blockedClaim.claimed) {
      expect(blockedClaim.reason).toBe("operator_hold");
    }

    // Release hold at H+60 -> resumed deletion_due_at MUST have >= 14 days left!
    const releaseAtMs = paidThrough + 60 * DAY_MS;
    const released = await setOperatorManualHold(env.PLATFORM_DB, {
      tenantId: holdTenant.tenantId,
      hold: false,
      reason: "Peninjauan selesai dan penahanan dilepas",
      operatorUserId: "op_t068_1",
      nowMs: releaseAtMs,
    });
    expect(released.operatorHold).toBe(false);
    expect(released.retentionPausedAtMs).toBeNull();
    expect(released.deletionDueAtMs).toBeGreaterThanOrEqual(
      releaseAtMs + HOLD_RELEASE_MIN_REMAINING_MS,
    );

    const resumedDueAt = released.deletionDueAtMs!;
    // 1 second before resumed deadline -> STILL blocked!
    const tooEarly = await claimTenantForOffboarding(env.PLATFORM_DB, {
      tenantId: holdTenant.tenantId,
      nowMs: resumedDueAt - 1000,
    });
    expect(tooEarly.claimed).toBe(false);
    if (!tooEarly.claimed) {
      expect(tooEarly.reason).toBe("before_deletion_due_at");
    }

    // At resumed deadline -> claim succeeds!
    const exactClaim = await claimTenantForOffboarding(env.PLATFORM_DB, {
      tenantId: holdTenant.tenantId,
      nowMs: resumedDueAt,
    });
    expect(exactClaim.claimed).toBe(true);
  });

  it("claims entitlement lock (status=purging, offboarding_started_at) BEFORE any external side effects and blocks on creating/creation_unknown/pending/review payment attempts", async () => {
    const paidThrough = Date.UTC(2026, 6, 1, 0, 0, 0);
    const dueAt = paidThrough + PAID_DELETION_WINDOW_MS;

    // 1. All 4 unresolved attempt states BLOCK offboarding claim!
    for (const attemptState of ["creating", "creation_unknown", "pending", "review"] as const) {
      const t = await seedTenantFixture({
        handle: `t068-blk-${attemptState.replace("_", "")}`,
        name: `Blocked ${attemptState}`,
        status: "suspended",
        ownerEmail: `owner-blk-${attemptState}@example.com`,
        paidThroughMs: paidThrough,
        createdAtMs: paidThrough - 30 * DAY_MS,
        seedTenantStore: false,
      });
      const oblId = uid("obl_blk_");
      const attId = uid("att_blk_");
      await env.PLATFORM_DB.batch([
        env.PLATFORM_DB.prepare(
          `INSERT INTO billing_obligations (
             id, tenant_id, payer_type, plan_interval, status,
             gross_amount_idr, discount_amount_idr, net_amount_idr,
             currency, due_at, review_required, version, created_at, updated_at
           ) VALUES (?, ?, 'tenant', 'monthly', 'open', 179000, 0, 179000, 'IDR', ?, 0, 1, ?, ?)`,
        ).bind(oblId, t.tenantId, dueAt + DAY_MS, dueAt - DAY_MS, dueAt - DAY_MS),
        env.PLATFORM_DB.prepare(
          `INSERT INTO payment_attempts (
             id, obligation_id, tenant_id, channel, provider, amount_idr,
             state, lifecycle_state, version, created_at, updated_at
           ) VALUES (?, ?, ?, 'QRIS', 'autolaris', 180000, 'pending', ?, 1, ?, ?)`,
        ).bind(attId, oblId, t.tenantId, attemptState, dueAt - DAY_MS, dueAt - DAY_MS),
      ]);

      const blocked = await claimTenantForOffboarding(env.PLATFORM_DB, {
        tenantId: t.tenantId,
        nowMs: dueAt + DAY_MS,
      });
      expect(blocked.claimed).toBe(false);
      if (!blocked.claimed) {
        expect(blocked.reason).toBe("unresolved_payment_attempt");
      }
    }

    // 2. Verify lock (status='purging', offboarding_started_at != NULL) is persisted BEFORE any side effect!
    const lockCheckTenant = await seedTenantFixture({
      handle: "t068-lock-before-se",
      name: "Lock Before Side Effects",
      status: "suspended",
      ownerEmail: "owner-lockse-68@example.com",
      paidThroughMs: paidThrough,
      createdAtMs: paidThrough - 30 * DAY_MS,
      customHost: { host: "www.lockse-68.example.id", cfId: "cf_ch_lockse_68" },
    });

    const observedStates: string[] = [];
    const assertLockedBeforeSideEffect = async (stage: string) => {
      const row = await env.PLATFORM_DB.prepare(
        "SELECT status, offboarding_started_at FROM tenants WHERE id = ?",
      )
        .bind(lockCheckTenant.tenantId)
        .first<{ readonly status: string; readonly offboarding_started_at: number | null }>();
      expect(row?.status).toBe("purging");
      expect(row?.offboarding_started_at).not.toBeNull();
      observedStates.push(stage);
    };

    const r2 = createInMemoryR2Bucket({
      onDelete: () => assertLockedBeforeSideEffect("r2"),
    });
    await r2.put(`t/${lockCheckTenant.tenantId}/media/x.webp`, "img");
    const cf = createMockCloudflareClient({
      onDelete: () => assertLockedBeforeSideEffect("cloudflare"),
    });
    const trackedNs = createTrackedTenantStoreNamespace(
      env.TENANT_STORE as unknown as TenantStoreNamespaceLike,
      {
        onDeleteAll: () => assertLockedBeforeSideEffect("tenant_store"),
      },
    );

    const sw = await runTenantOffboardingSweep(env, {
      nowMs: dueAt,
      tenantId: lockCheckTenant.tenantId,
      cloudflareClient: cf,
      mediaBucket: r2,
      tenantStoreNamespace: trackedNs.namespace,
    });
    expect(sw.tenantsPurged).toBe(1);
    expect(observedStates).toEqual(["cloudflare", "r2", "tenant_store"]);
  });

  it("serializes concurrent payment, settlement, and operator hold against offboarding and routes post-claim payments/late settlements cleanly", async () => {
    const paidThrough = Date.UTC(2026, 6, 1, 0, 0, 0);
    const dueAt = paidThrough + PAID_DELETION_WINDOW_MS;

    // 1. Concurrent beginDurablePaymentAttempt vs claimTenantForOffboarding
    const racePayTenant = await seedTenantFixture({
      handle: "t068-race-pay",
      name: "Race Pay Co",
      status: "suspended",
      ownerEmail: "owner-racepay-68@example.com",
      paidThroughMs: paidThrough,
      createdAtMs: paidThrough - 30 * DAY_MS,
      seedTenantStore: false,
    });

    const [payOutcome, claimOutcome1] = await Promise.allSettled([
      beginDurablePaymentAttempt(env.PLATFORM_DB, {
        tenantId: racePayTenant.tenantId,
        effectiveTenantStatus: "suspended",
        payerType: "tenant",
        payerAgencyId: null,
        plan: "monthly",
        channelKind: "QRIS",
        channelCode: "QRIS",
        estimatedChannelFeeIdr: 1000,
        idempotencyKey: `race-pay-${uid("k")}`,
        requestHash: "hash-race-pay",
        providerAccountId: "default",
        nowMs: dueAt,
      }),
      claimTenantForOffboarding(env.PLATFORM_DB, {
        tenantId: racePayTenant.tenantId,
        nowMs: dueAt,
      }),
    ]);

    const paySucceeded = payOutcome.status === "fulfilled";
    const claim1Succeeded = claimOutcome1.status === "fulfilled" && claimOutcome1.value.claimed;
    // Exactly one wins — NEVER both!
    expect(paySucceeded && claim1Succeeded).toBe(false);
    expect(paySucceeded || claim1Succeeded).toBe(true);

    // 2. Concurrent settlement vs offboarding claim
    const raceSettleTenant = await seedTenantFixture({
      handle: "t068-race-settle",
      name: "Race Settle Co",
      status: "suspended",
      ownerEmail: "owner-racesettle-68@example.com",
      paidThroughMs: paidThrough,
      createdAtMs: paidThrough - 30 * DAY_MS,
      seedTenantStore: false,
    });
    const oblId = uid("obl_rs_");
    const attId = uid("att_rs_");
    // Expired attempt can still receive late settlement via Advice while not blocking claim
    await env.PLATFORM_DB.batch([
      env.PLATFORM_DB.prepare(
        `INSERT INTO billing_obligations (
           id, tenant_id, payer_type, plan_interval, status,
           gross_amount_idr, discount_amount_idr, net_amount_idr,
           currency, due_at, review_required, version, created_at, updated_at
         ) VALUES (?, ?, 'tenant', 'monthly', 'open', 179000, 0, 179000, 'IDR', ?, 0, 1, ?, ?)`,
      ).bind(oblId, raceSettleTenant.tenantId, dueAt - DAY_MS, dueAt - 2 * DAY_MS, dueAt - 2 * DAY_MS),
      env.PLATFORM_DB.prepare(
        `INSERT INTO payment_attempts (
           id, obligation_id, tenant_id, channel, provider, provider_transaction_id,
           amount_idr, state, lifecycle_state, total_payable_idr, version, created_at, updated_at
         ) VALUES (?, ?, ?, 'QRIS', 'autolaris', ?, 180000, 'expired', 'expired', 180000, 1, ?, ?)`,
      ).bind(attId, oblId, raceSettleTenant.tenantId, `trx_rs_${uid("x")}`, dueAt - 2 * DAY_MS, dueAt - 2 * DAY_MS),
    ]);

    const [settleRace, claimRace2] = await Promise.all([
      settleVerifiedPaymentAttempt(env.PLATFORM_DB, {
        attemptId: attId,
        obligationId: oblId,
        tenantId: raceSettleTenant.tenantId,
        plan: "monthly",
        verifiedAmountIdr: 180000,
        providerTransactionId: `trx_rs_live_${uid("x")}`,
        providerStatus: "SETTLED",
        policyProfile: "autolaris_v1",
        policyVersion: "1",
        settledAtMs: dueAt,
        reconciledVia: "advice",
        actorUserId: null,
        actorRole: "system",
        nowMs: dueAt,
      }),
      claimTenantForOffboarding(env.PLATFORM_DB, {
        tenantId: raceSettleTenant.tenantId,
        nowMs: dueAt,
      }),
    ]);

    const settledWon = settleRace.outcome === "settled";
    const claim2Won = claimRace2.claimed;
    // NEVER deleted-but-paid!
    expect(settledWon && claim2Won).toBe(false);
    expect(settledWon || claim2Won).toBe(true);
    if (claim2Won) {
      expect(settleRace.outcome).toBe("review");
    }

    // 3. Concurrent operator hold vs offboarding claim -> NEVER held-but-deleted!
    const raceHoldTenant = await seedTenantFixture({
      handle: "t068-race-hold",
      name: "Race Hold Co",
      status: "suspended",
      ownerEmail: "owner-racehold-68@example.com",
      paidThroughMs: paidThrough,
      createdAtMs: paidThrough - 30 * DAY_MS,
      seedTenantStore: false,
    });
    const [holdRace, claimRace3] = await Promise.allSettled([
      setOperatorManualHold(env.PLATFORM_DB, {
        tenantId: raceHoldTenant.tenantId,
        hold: true,
        reason: "Penahanan operator serentak dengan jadwal penghapusan",
        operatorUserId: "op_t068_race",
        nowMs: dueAt,
      }),
      claimTenantForOffboarding(env.PLATFORM_DB, {
        tenantId: raceHoldTenant.tenantId,
        nowMs: dueAt,
      }),
    ]);
    const holdWon = holdRace.status === "fulfilled" && holdRace.value.operatorHold;
    const claim3Won = claimRace3.status === "fulfilled" && claimRace3.value.claimed;
    expect(holdWon && claim3Won).toBe(false);
    expect(holdWon || claim3Won).toBe(true);

    // 4. After claim (`status = 'purging'`):
    //    - new payment attempt (direct AND with coupon) rejected with 409 TENANT_OFFBOARDING_IN_PROGRESS
    //    - operator hold rejected with 409 INVALID_LIFECYCLE_STATE
    //    - late settlement routes cleanly to `review` with 0 entitlement grants!
    const claimedTenant = await seedTenantFixture({
      handle: "t068-post-claim",
      name: "Post Claim Co",
      status: "suspended",
      ownerEmail: "owner-postclaim-68@example.com",
      paidThroughMs: paidThrough,
      createdAtMs: paidThrough - 30 * DAY_MS,
      seedTenantStore: false,
    });

    const lateOblId = uid("obl_late_");
    const lateAttId = uid("att_late_");
    await env.PLATFORM_DB.batch([
      env.PLATFORM_DB.prepare(
        `INSERT INTO billing_obligations (
           id, tenant_id, payer_type, plan_interval, status,
           gross_amount_idr, discount_amount_idr, net_amount_idr,
           currency, due_at, review_required, version, created_at, updated_at
         ) VALUES (?, ?, 'tenant', 'monthly', 'open', 179000, 0, 179000, 'IDR', ?, 0, 1, ?, ?)`,
      ).bind(lateOblId, claimedTenant.tenantId, dueAt - DAY_MS, dueAt - 2 * DAY_MS, dueAt - 2 * DAY_MS),
      env.PLATFORM_DB.prepare(
        `INSERT INTO payment_attempts (
           id, obligation_id, tenant_id, channel, provider, provider_transaction_id,
           amount_idr, state, lifecycle_state, total_payable_idr, version, created_at, updated_at
         ) VALUES (?, ?, ?, 'QRIS', 'autolaris', ?, 180000, 'expired', 'expired', 180000, 1, ?, ?)`,
      ).bind(lateAttId, lateOblId, claimedTenant.tenantId, `trx_late_${uid("x")}`, dueAt - 2 * DAY_MS, dueAt - 2 * DAY_MS),
    ]);

    const claimed = await claimTenantForOffboarding(env.PLATFORM_DB, {
      tenantId: claimedTenant.tenantId,
      nowMs: dueAt,
    });
    expect(claimed.claimed).toBe(true);

    // Direct new payment attempt rejected
    await expect(
      beginDurablePaymentAttempt(env.PLATFORM_DB, {
        tenantId: claimedTenant.tenantId,
        effectiveTenantStatus: "suspended",
        payerType: "tenant",
        payerAgencyId: null,
        plan: "monthly",
        channelKind: "QRIS",
        channelCode: "QRIS",
        estimatedChannelFeeIdr: 1000,
        idempotencyKey: `post-claim-direct-${uid("k")}`,
        requestHash: "hash-pc-direct",
        providerAccountId: "default",
        nowMs: dueAt + 1000,
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      reasonCode: "TENANT_OFFBOARDING_IN_PROGRESS",
    });

    // Coupon new payment attempt also rejected
    const createdCoupon = await createPromoCoupon(env.PLATFORM_DB, {
      input: {
        code: "PROMO68",
        discountKind: "percent",
        discountValue: 10,
        eligiblePlans: ["monthly"],
        eligiblePayerTypes: ["tenant"],
        maxRedemptions: 100,
        startsAtMs: dueAt - 10 * DAY_MS,
        endsAtMs: dueAt + 10 * DAY_MS,
        active: true,
        notes: "Test coupon for offboarding rejection check",
        reason: "Create promotional coupon for offboarding rejection test",
      },
      actorUserId: "op_t068_cpn",
      actorRole: "platform_operator",
      requestId: "req_t068_cpn",
      nowMs: dueAt,
    });
    await expect(
      beginDurablePaymentAttemptWithCoupon(env.PLATFORM_DB, {
        tenantId: claimedTenant.tenantId,
        effectiveTenantStatus: "suspended",
        payerType: "tenant",
        payerAgencyId: null,
        plan: "monthly",
        channelKind: "QRIS",
        channelCode: "QRIS",
        estimatedChannelFeeIdr: 1000,
        couponCode: createdCoupon.coupon.code,
        idempotencyKey: `post-claim-coupon-${uid("k")}`,
        requestHash: "hash-pc-coupon",
        providerAccountId: "default",
        nowMs: dueAt + 1000,
      }),
    ).rejects.toBeInstanceOf(BillingConflictError);

    // Operator hold rejected on purging tenant
    await expect(
      setOperatorManualHold(env.PLATFORM_DB, {
        tenantId: claimedTenant.tenantId,
        hold: true,
        reason: "Mencoba menahan situs yang sudah dalam proses penghapusan",
        operatorUserId: "op_t068_hold",
        nowMs: dueAt + 1000,
      }),
    ).rejects.toBeInstanceOf(InvalidLifecycleStateError);

    // Late settlement goes cleanly to `review` and NEVER reactivates the tenant!
    const lateSettled = await settleVerifiedPaymentAttempt(env.PLATFORM_DB, {
      attemptId: lateAttId,
      obligationId: lateOblId,
      tenantId: claimedTenant.tenantId,
      plan: "monthly",
      verifiedAmountIdr: 180000,
      providerTransactionId: `trx_late_settle_${uid("x")}`,
      providerStatus: "SETTLED",
      policyProfile: "autolaris_v1",
      policyVersion: "1",
      settledAtMs: dueAt + 5000,
      reconciledVia: "advice",
      actorUserId: null,
      actorRole: "system",
      nowMs: dueAt + 5000,
    });
    expect(lateSettled.outcome).toBe("review");
    expect(lateSettled.grantApplied).toBe(false);

    const afterLateRow = await env.PLATFORM_DB.prepare(
      "SELECT status FROM tenants WHERE id = ?",
    )
      .bind(claimedTenant.tenantId)
      .first<{ readonly status: string }>();
    expect(afterLateRow?.status).toBe("purging");
  });

  it("resumes an interrupted purge job idempotently without duplicate external deletes, preserves billing/audit/receipts, enforces 30-day handle quarantine, and replays tombstone on backup restore", async () => {
    const paidThrough = Date.UTC(2026, 6, 1, 0, 0, 0);
    const dueAt = paidThrough + PAID_DELETION_WINDOW_MS;
    const handle = "t068-resumable-handle";

    const tenant = await seedTenantFixture({
      handle,
      name: "Resumable Purge Co",
      status: "suspended",
      ownerEmail: "owner-resume-68@example.com",
      paidThroughMs: paidThrough,
      createdAtMs: paidThrough - 30 * DAY_MS,
      customHost: { host: "www.resumable-68.example.id", cfId: "cf_ch_resume_68" },
    });

    // Seed paid receipt + unsettled open billing obligation to prove BOTH survive & open is de-identified!
    const paidOblId = uid("obl_paid_");
    const paidAttId = uid("att_paid_");
    const stlId = uid("stl_paid_");
    const openOblId = uid("obl_open_");
    const receiptId = uid("rcpt_");

    await env.PLATFORM_DB.batch([
      env.PLATFORM_DB.prepare(
        `INSERT INTO billing_obligations (
           id, tenant_id, payer_type, plan_interval, status,
           gross_amount_idr, discount_amount_idr, net_amount_idr,
           currency, due_at, paid_at, review_required, version, created_at, updated_at
         ) VALUES (?, ?, 'tenant', 'monthly', 'paid', 179000, 0, 179000, 'IDR', ?, ?, 0, 1, ?, ?)`,
      ).bind(paidOblId, tenant.tenantId, paidThrough - 29 * DAY_MS, paidThrough - 30 * DAY_MS, paidThrough - 30 * DAY_MS, paidThrough - 30 * DAY_MS),
      env.PLATFORM_DB.prepare(
        `INSERT INTO payment_attempts (
           id, obligation_id, tenant_id, channel, provider, provider_transaction_id,
           amount_idr, state, lifecycle_state, total_payable_idr, version, created_at, updated_at
         ) VALUES (?, ?, ?, 'QRIS', 'autolaris', ?, 180000, 'settled', 'paid', 180000, 1, ?, ?)`,
      ).bind(paidAttId, paidOblId, tenant.tenantId, `trx_paid_${uid("x")}`, paidThrough - 30 * DAY_MS, paidThrough - 30 * DAY_MS),
      env.PLATFORM_DB.prepare(
        `INSERT INTO settlements (id, obligation_id, payment_attempt_id, tenant_id, amount_idr, settled_at, reconciled_via, created_at)
         VALUES (?, ?, ?, ?, 180000, ?, 'advice', ?)`,
      ).bind(stlId, paidOblId, paidAttId, tenant.tenantId, paidThrough - 30 * DAY_MS, paidThrough - 30 * DAY_MS),
      env.PLATFORM_DB.prepare(
        `INSERT INTO payment_receipts (
           id, receipt_number, document_kind, tenant_id, obligation_id, settlement_id,
           payer_user_id, currency, base_amount_idr, discount_amount_idr, channel_fee_idr,
           total_amount_idr, plan_code, payment_channel, r2_object_key, pdf_sha256,
           pdf_byte_length, non_pkp_notice, issued_at, created_at
         ) VALUES (?, ?, 'receipt', ?, ?, ?, ?, 'IDR', 179000, 0, 1000, 180000, 'monthly', 'QRIS', ?, 'deadbeef', 1024, 'Non-PKP', ?, ?)`,
      ).bind(
        receiptId,
        `PS-2026-${String(++seq).padStart(6, "0")}`,
        tenant.tenantId,
        paidOblId,
        stlId,
        tenant.ownerUserId,
        `receipts/2026/${receiptId}.pdf`,
        paidThrough - 30 * DAY_MS,
        paidThrough - 30 * DAY_MS,
      ),
      // Unsettled open charge (expired attempt, so does not block offboarding claim)
      env.PLATFORM_DB.prepare(
        `INSERT INTO billing_obligations (
           id, tenant_id, payer_type, plan_interval, status,
           gross_amount_idr, discount_amount_idr, net_amount_idr,
           currency, due_at, review_required, version, created_at, updated_at
         ) VALUES (?, ?, 'tenant', 'monthly', 'open', 179000, 0, 179000, 'IDR', ?, 0, 1, ?, ?)`,
      ).bind(openOblId, tenant.tenantId, dueAt - 5 * DAY_MS, dueAt - 6 * DAY_MS, dueAt - 6 * DAY_MS),
    ]);

    // Take a backup snapshot BEFORE purge (for backup-restore tombstone replay test!)
    const backupBucket = createInMemoryR2Bucket();
    const backupRes = await runDailyPlatformBackup({
      platformDb: env.PLATFORM_DB,
      backupBucket: backupBucket as unknown as Parameters<typeof runDailyPlatformBackup>[0]["backupBucket"],
      nowMs: dueAt - DAY_MS,
    });
    expect(backupRes.snapshotKey).toContain("snapshot.sql");

    // Simulate interrupted purge: fail R2 delete on first attempt AFTER Cloudflare delete succeeds!
    let r2Calls = 0;
    const r2 = createInMemoryR2Bucket({
      onDelete() {
        r2Calls += 1;
        if (r2Calls === 1) {
          throw new Error("R2_TRANSIENT_TIMEOUT");
        }
      },
    });
    await r2.put(`t/${tenant.tenantId}/media/photo.webp`, "binary-photo");
    await r2.put(`receipts/2026/${receiptId}.pdf`, "immutable-receipt-pdf");

    const cf = createMockCloudflareClient();
    const realNs = env.TENANT_STORE as unknown as TenantStoreNamespaceLike;
    const trackedNs = createTrackedTenantStoreNamespace(realNs);

    // Attempt 1 via Durable Queue: claims & deletes CF hostname, fails on R2 -> retries cleanly!
    const { batch: batch1, retried: retried1 } = buildQueueBatch([
      {
        id: "purge-1",
        body: {
          idempotencyKey: `purge-resume-${tenant.tenantId}`,
          topic: TENANT_OFFBOARDING_PURGE_TOPIC,
          tenantId: tenant.tenantId,
          payload: { tenantId: tenant.tenantId, scheduledAtMs: dueAt },
          enqueuedAt: dueAt,
        },
      },
    ]);
    const q1 = await processDurableQueueBatch(
      batch1,
      env,
      createOffboardingJobRegistry({
        cloudflareClient: cf,
        mediaBucket: r2,
        tenantStoreNamespace: trackedNs.namespace,
      }),
      { now: () => dueAt },
    );
    expect(q1.retried).toBe(1);
    expect(retried1.has("purge-1")).toBe(true);
    expect(cf.deletedIds).toEqual(["cf_ch_resume_68"]);

    const midRun = await getTenantOffboardingRun(env.PLATFORM_DB, tenant.tenantId);
    expect(midRun?.hostnamesPurgedAtMs).not.toBeNull();
    expect(midRun?.r2PurgedAtMs).toBeNull();

    // Attempt 2: resumes from checkpoint -> ZERO duplicate Cloudflare delete calls!
    const { batch: batch2, acked: acked2 } = buildQueueBatch([
      {
        id: "purge-2",
        body: {
          idempotencyKey: `purge-resume-${tenant.tenantId}`,
          topic: TENANT_OFFBOARDING_PURGE_TOPIC,
          tenantId: tenant.tenantId,
          payload: { tenantId: tenant.tenantId, scheduledAtMs: dueAt + 5000 },
          enqueuedAt: dueAt,
        },
      },
    ]);
    const q2 = await processDurableQueueBatch(
      batch2,
      env,
      createOffboardingJobRegistry({
        cloudflareClient: cf,
        mediaBucket: r2,
        tenantStoreNamespace: trackedNs.namespace,
      }),
      { now: () => dueAt + 5000 },
    );
    expect(q2.completed).toBe(1);
    expect(acked2.has("purge-2")).toBe(true);
    // STILL only 1 Cloudflare delete call!
    expect(cf.deletedIds).toEqual(["cf_ch_resume_68"]);
    expect(await r2.head(`t/${tenant.tenantId}/media/photo.webp`)).toBeNull();
    // Immutable receipt PDF outside t/<tenantId>/ survived!
    expect(await r2.head(`receipts/2026/${receiptId}.pdf`)).not.toBeNull();

    // Re-running executeTenantOffboardingPurge directly is a safe idempotent no-op!
    const replayPurge = await executeTenantOffboardingPurge({
      platformDb: env.PLATFORM_DB,
      tenantId: tenant.tenantId,
      cloudflareClient: cf,
      mediaBucket: r2,
      tenantStoreNamespace: trackedNs.namespace,
      nowMs: dueAt + 10_000,
    });
    expect(replayPurge.outcome).toBe("already_purged");
    expect(cf.deletedIds).toEqual(["cf_ch_resume_68"]);

    // Verify ALL billing, payment, receipt, audit, and tombstone rows SURVIVED & open charge de-identified!
    const openOblAfter = await env.PLATFORM_DB.prepare(
      "SELECT status, deidentified_at FROM billing_obligations WHERE id = ?",
    )
      .bind(openOblId)
      .first<{ readonly status: string; readonly deidentified_at: number | null }>();
    expect(openOblAfter?.status).toBe("canceled");
    expect(openOblAfter?.deidentified_at).not.toBeNull();

    const paidOblAfter = await env.PLATFORM_DB.prepare(
      "SELECT status, net_amount_idr FROM billing_obligations WHERE id = ?",
    )
      .bind(paidOblId)
      .first<{ readonly status: string; readonly net_amount_idr: number }>();
    expect(paidOblAfter?.status).toBe("paid");
    expect(paidOblAfter?.net_amount_idr).toBe(179000);

    const receiptAfter = await env.PLATFORM_DB.prepare(
      "SELECT id FROM payment_receipts WHERE id = ?",
    )
      .bind(receiptId)
      .first<{ readonly id: string }>();
    expect(receiptAfter?.id).toBe(receiptId);

    const auditRows = await env.PLATFORM_DB.prepare(
      "SELECT action FROM platform_audit WHERE tenant_id = ? AND action LIKE 'tenant.offboarding.%' ORDER BY created_at ASC",
    )
      .bind(tenant.tenantId)
      .all<{ readonly action: string }>();
    expect(auditRows.results.map((r) => r.action)).toEqual([
      "tenant.offboarding.claimed",
      "tenant.offboarding.purged",
    ]);

    // Verify 30-day handle quarantine!
    const purgedAt = dueAt + 5000;
    const availDay1 = await checkHandleAvailability(env.PLATFORM_DB, handle, {
      nowMs: purgedAt + DAY_MS,
    });
    expect(availDay1.available).toBe(false);
    expect(availDay1.code).toBe("HANDLE_TAKEN");

    const availDay29 = await checkHandleAvailability(env.PLATFORM_DB, handle, {
      nowMs: purgedAt + 30 * DAY_MS - 1000,
    });
    expect(availDay29.available).toBe(false);

    const availDay30 = await checkHandleAvailability(env.PLATFORM_DB, handle, {
      nowMs: purgedAt + 30 * DAY_MS,
    });
    expect(availDay30.available).toBe(true);
    expect(availDay30.code).toBe("AVAILABLE");

    // Verify backup-restore fixture replays the tombstone and deletes resurrected tenant again!
    const tombstoneRow = await env.PLATFORM_DB.prepare(
      "SELECT id, tenant_id, handle, quarantine_until, reason, deleted_by, deleted_at FROM deletion_tombstones WHERE tenant_id = ?",
    )
      .bind(tenant.tenantId)
      .first<{
        readonly id: string;
        readonly tenant_id: string;
        readonly handle: string;
        readonly quarantine_until: number;
        readonly reason: string;
        readonly deleted_by: string | null;
        readonly deleted_at: number;
      }>();
    expect(tombstoneRow?.handle).toBe(handle);

    // Re-seed R2 & TenantStore to simulate backup resurrection of the purged tenant!
    const restoredR2 = createInMemoryR2Bucket();
    await restoredR2.put(`t/${tenant.tenantId}/media/resurrected.webp`, "ghost-file");
    const restoredTenantDb = createTenantDb(openTenantStoreStub(realNs, tenant.tenantId));
    await restoredTenantDb
      .prepare(
        `INSERT INTO pages (slug, title, status, draft_sections_json, published_sections_json, version, created_at, updated_at)
         VALUES ('ghost', 'Ghost Page', 'published', '[]', '[]', 1, ?, ?)`,
      )
      .bind(dueAt, dueAt)
      .run();

    // Simulate pre-purge PLATFORM_DB row resurrection (status='suspended', original handle, active host,
    // plus resurrected member & session rows)
    await env.PLATFORM_DB.batch([
      env.PLATFORM_DB.prepare(
        "UPDATE tenants SET status = 'suspended', handle = ?, name = 'Resurrected Co' WHERE id = ?",
      ).bind(handle, tenant.tenantId),
      env.PLATFORM_DB.prepare(
        `INSERT OR REPLACE INTO tenant_hosts (
           host, tenant_id, kind, cf_custom_hostname_id, status, ssl_status,
           is_primary, version, created_at, updated_at
         ) VALUES ('www.resumable-68.example.id', ?, 'custom', 'cf_ch_ghost_68', 'active', 'active', 1, 1, ?, ?)`,
      ).bind(tenant.tenantId, dueAt, dueAt),
      env.PLATFORM_DB.prepare(
        `INSERT OR REPLACE INTO members (id, organization_id, user_id, role, created_at)
         VALUES ('mem_ghost_68', ?, ?, 'owner', ?)`,
      ).bind(tenant.orgId, tenant.ownerUserId, dueAt),
      env.PLATFORM_DB.prepare(
        `INSERT OR REPLACE INTO sessions (id, user_id, token, expires_at, active_organization_id, created_at, updated_at)
         VALUES ('sess_ghost_68', ?, 'tok_ghost_68', ?, ?, ?, ?)`,
      ).bind(tenant.ownerUserId, purgedAt + DAY_MS, tenant.orgId, dueAt, dueAt),
    ]);

    const cfReplay = createMockCloudflareClient();
    const replayRes = await replayOffboardingTombstonesFull({
      platformDb: env.PLATFORM_DB,
      mediaBucket: restoredR2,
      tenantStoreNamespace: trackedNs.namespace,
      cloudflareClient: cfReplay,
      nowMs: purgedAt + 60_000,
    });
    expect(replayRes.tenantsRePurged).toBeGreaterThanOrEqual(1);
    expect(replayRes.r2ObjectsDeleted).toBe(1);
    expect(replayRes.customHostnamesDeleted).toBe(1);
    expect(replayRes.tenantStoresPurged).toBeGreaterThanOrEqual(1);
    expect(replayRes.membershipsRemoved).toBeGreaterThanOrEqual(1);
    expect(replayRes.sessionsRevoked).toBeGreaterThanOrEqual(1);
    expect(await restoredR2.head(`t/${tenant.tenantId}/media/resurrected.webp`)).toBeNull();

    const ghostMembersAfter = await env.PLATFORM_DB.prepare(
      "SELECT COUNT(*) AS cnt FROM members WHERE organization_id = ?",
    )
      .bind(tenant.orgId)
      .first<{ readonly cnt: number }>();
    expect(Number(ghostMembersAfter?.cnt ?? 0)).toBe(0);

    const ghostSessionsAfter = await env.PLATFORM_DB.prepare(
      "SELECT COUNT(*) AS cnt FROM sessions WHERE active_organization_id = ?",
    )
      .bind(tenant.orgId)
      .first<{ readonly cnt: number }>();
    expect(Number(ghostSessionsAfter?.cnt ?? 0)).toBe(0);

    const ghostTenantAfter = await env.PLATFORM_DB.prepare(
      "SELECT status, handle FROM tenants WHERE id = ?",
    )
      .bind(tenant.tenantId)
      .first<{ readonly status: string; readonly handle: string }>();
    expect(ghostTenantAfter?.status).toBe("purged");
    expect(ghostTenantAfter?.handle).not.toBe(handle);

    const ghostPagesAfter = await restoredTenantDb
      .prepare("SELECT COUNT(*) AS cnt FROM pages")
      .first<{ readonly cnt: number }>();
    expect(Number(ghostPagesAfter?.cnt ?? 0)).toBe(0);

    // Ensure runIsolatedRestoreDrill import is referenced & backup snapshot valid
    expect(typeof runIsolatedRestoreDrill).toBe("function");
    expect(TENANT_OFFBOARDING_SWEEP_TOPIC).toBe("offboarding.sweep");
  });

  it("allows owner-only leads CSV export while locked/suspended (passing lockout allowlist), blocks other lead APIs, enforces RBAC/cross-tenant/rate-limit/audit/headers", async () => {
    const nowMs = Date.UTC(2026, 10, 22, 12, 0, 0);

    const tenantA = await seedTenantFixture({
      handle: "t068-export-a",
      name: "Export A Co",
      status: "suspended",
      ownerEmail: "owner-exp-a@example.com",
      paidThroughMs: nowMs - 10 * DAY_MS, // H+10 -> suspended
      createdAtMs: nowMs - 40 * DAY_MS,
    });

    // Add Admin, Editor on Tenant A, and unrelated Owner on Tenant B
    const adminA = await signUpUser("admin-exp-a@example.com", "Admin A");
    const editorA = await signUpUser("editor-exp-a@example.com", "Editor A");
    const tenantB = await seedTenantFixture({
      handle: "t068-export-b",
      name: "Export B Co",
      status: "active",
      ownerEmail: "owner-exp-b@example.com",
      paidThroughMs: nowMs + 30 * DAY_MS,
      createdAtMs: nowMs - 10 * DAY_MS,
    });

    await env.PLATFORM_DB.batch([
      env.PLATFORM_DB.prepare(
        "INSERT INTO members (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, 'admin', ?)",
      ).bind(uid("mem_"), tenantA.orgId, adminA.userId, nowMs),
      env.PLATFORM_DB.prepare(
        "INSERT INTO members (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, 'editor', ?)",
      ).bind(uid("mem_"), tenantA.orgId, editorA.userId, nowMs),
    ]);

    const realNs = env.TENANT_STORE as unknown as TenantStoreNamespaceLike;
    const leadsEnv = {
      ...buildAuthEnv(),
      SAAS_ZONE: "situsku.click",
      TENANT_STORE: realNs,
    };

    // 1. Suspended Tenant A: middleware lockout allowlist PASSES /leads/export for owner,
    //    while /leads (inbox list) is BLOCKED with 403 SUBSCRIPTION_LOCKED!
    const mwExportLocals = createMiddlewareLocals("app");
    const mwExportRes = await executeAuthMiddleware(
      {
        request: makeAdminRequest(`/api/tenants/${tenantA.tenantId}/leads/export`, "GET", tenantA.ownerCookie),
        locals: mwExportLocals,
      },
      () =>
        handleTenantLeadsExportRequest(
          tenantA.tenantId,
          makeAdminRequest(`/api/tenants/${tenantA.tenantId}/leads/export`, "GET", tenantA.ownerCookie),
          leadsEnv,
          {
            authenticatedUser: mwExportLocals.authUser,
            activeOrganizationId: mwExportLocals.authSession?.activeOrganizationId ?? null,
            nowMs,
            rateLimitMax: 2,
            rateLimitWindowMs: 60_000,
          },
        ),
      buildAuthEnv(),
      { nowMs },
    );
    expect(mwExportRes.status).toBe(200);
    expect(mwExportRes.headers.get("content-type")).toContain("text/csv");
    expect(mwExportRes.headers.get("cache-control")).toBe("private, no-store");
    expect(mwExportRes.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(mwExportRes.headers.get("x-content-type-options")).toBe("nosniff");
    const csvBody = await mwExportRes.text();
    expect(csvBody).toContain("Prospek Uji");

    // Verify platform_audit + tenant_activity_log recorded the export with ZERO PII!
    const auditRow = await env.PLATFORM_DB.prepare(
      "SELECT action, outcome, metadata_json FROM platform_audit WHERE tenant_id = ? AND action = 'tenant.leads.export_csv' ORDER BY created_at DESC LIMIT 1",
    )
      .bind(tenantA.tenantId)
      .first<{ readonly action: string; readonly outcome: string; readonly metadata_json: string | null }>();
    expect(auditRow?.outcome).toBe("success");
    expect(auditRow?.metadata_json ?? "").not.toContain("Prospek Uji");
    expect(auditRow?.metadata_json ?? "").not.toContain("lead@example.com");

    // Other lead APIs on suspended tenant STAY LOCKED (`403 SUBSCRIPTION_LOCKED`)!
    const suspendedListRes = await handleTenantLeadsListRequest(
      tenantA.tenantId,
      makeAdminRequest(`/api/tenants/${tenantA.tenantId}/leads`, "GET", tenantA.ownerCookie),
      leadsEnv,
      { nowMs },
    );
    expect(suspendedListRes.status).toBe(403);
    const suspendedListBody = (await suspendedListRes.json()) as { error?: { code?: string } };
    expect(suspendedListBody.error?.code).toBe("SUBSCRIPTION_LOCKED");

    // 2. Role & cross-tenant denials: Admin -> 403, Editor -> 403, Tenant B owner -> 404!
    const adminRes = await handleTenantLeadsExportRequest(
      tenantA.tenantId,
      makeAdminRequest(`/api/tenants/${tenantA.tenantId}/leads/export`, "GET", adminA.cookie),
      leadsEnv,
      { nowMs, rateLimitMax: 10 },
    );
    expect(adminRes.status).toBe(403);

    const editorRes = await handleTenantLeadsExportRequest(
      tenantA.tenantId,
      makeAdminRequest(`/api/tenants/${tenantA.tenantId}/leads/export`, "GET", editorA.cookie),
      leadsEnv,
      { nowMs, rateLimitMax: 10 },
    );
    expect(editorRes.status).toBe(403);

    const crossTenantRes = await handleTenantLeadsExportRequest(
      tenantA.tenantId,
      makeAdminRequest(`/api/tenants/${tenantA.tenantId}/leads/export`, "GET", tenantB.ownerCookie),
      leadsEnv,
      { nowMs, rateLimitMax: 10 },
    );
    expect(crossTenantRes.status).toBe(404);

    // 3. Rate limit (ceiling = 2; request #1 already used, #2 succeeds, #3 -> 429 RATE_LIMITED!)
    const req2 = await handleTenantLeadsExportRequest(
      tenantA.tenantId,
      makeAdminRequest(`/api/tenants/${tenantA.tenantId}/leads/export`, "GET", tenantA.ownerCookie),
      leadsEnv,
      { nowMs: nowMs + 1000, rateLimitMax: 2, rateLimitWindowMs: 60_000 },
    );
    expect(req2.status).toBe(200);

    const req3 = await handleTenantLeadsExportRequest(
      tenantA.tenantId,
      makeAdminRequest(`/api/tenants/${tenantA.tenantId}/leads/export`, "GET", tenantA.ownerCookie),
      leadsEnv,
      { nowMs: nowMs + 2000, rateLimitMax: 2, rateLimitWindowMs: 60_000 },
    );
    expect(req3.status).toBe(429);
    expect(req3.headers.get("retry-after")).toBeTruthy();
    expect(req3.headers.get("cache-control")).toBe("private, no-store");
    expect(req3.headers.get("x-robots-tag")).toBe("noindex, nofollow");

    // 4. Locked tenant (`H+5`): owner CSV export works while lead mutations stay locked (403 SUBSCRIPTION_LOCKED)!
    await env.PLATFORM_DB.prepare(
      "UPDATE tenants SET status = 'locked', paid_through = ? WHERE id = ?",
    )
      .bind(nowMs - 5 * DAY_MS, tenantA.tenantId)
      .run();

    const lockedExportRes = await handleTenantLeadsExportRequest(
      tenantA.tenantId,
      makeAdminRequest(`/api/tenants/${tenantA.tenantId}/leads/export`, "GET", tenantA.ownerCookie),
      leadsEnv,
      { nowMs: nowMs + 120_000, rateLimitMax: 10, rateLimitWindowMs: 60_000 },
    );
    expect(lockedExportRes.status).toBe(200);

    const lockedPatchRes = await handleTenantLeadDetailRequest(
      tenantA.tenantId,
      "1",
      makeAdminRequest(`/api/tenants/${tenantA.tenantId}/leads/1`, "PATCH", tenantA.ownerCookie, {
        status: "contacted",
        version: 1,
      }),
      leadsEnv,
      { nowMs: nowMs + 120_000 },
    );
    expect(lockedPatchRes.status).toBe(403);
    const lockedPatchBody = (await lockedPatchRes.json()) as { error?: { code?: string } };
    expect(lockedPatchBody.error?.code).toBe("SUBSCRIPTION_LOCKED");

    // 5. `/leads/export.csv` alias delegates to the hardened handler (rate-limited, audited, fail-closed,
    //    and single-statement atomic rate-limit NEVER inflates `request_count` past `limit`!)
    const aliasWindowNow = nowMs + 600_000;
    const csvAlias1 = await handleTenantLeadsExportCsvRequest(
      tenantA.tenantId,
      makeAdminRequest(`/api/tenants/${tenantA.tenantId}/leads/export.csv`, "GET", tenantA.ownerCookie),
      leadsEnv,
      { nowMs: aliasWindowNow, rateLimitMax: 2, rateLimitWindowMs: 60_000 },
    );
    expect(csvAlias1.status).toBe(200);
    expect(csvAlias1.headers.get("x-ratelimit-limit")).toBe("2");
    expect(csvAlias1.headers.get("x-ratelimit-remaining")).toBe("1");

    const csvAlias2 = await handleTenantLeadsExportCsvRequest(
      tenantA.tenantId,
      makeAdminRequest(`/api/tenants/${tenantA.tenantId}/leads/export.csv`, "GET", tenantA.ownerCookie),
      leadsEnv,
      { nowMs: aliasWindowNow + 1000, rateLimitMax: 2, rateLimitWindowMs: 60_000 },
    );
    expect(csvAlias2.status).toBe(200);
    expect(csvAlias2.headers.get("x-ratelimit-remaining")).toBe("0");

    const csvAlias3 = await handleTenantLeadsExportCsvRequest(
      tenantA.tenantId,
      makeAdminRequest(`/api/tenants/${tenantA.tenantId}/leads/export.csv`, "GET", tenantA.ownerCookie),
      leadsEnv,
      { nowMs: aliasWindowNow + 2000, rateLimitMax: 2, rateLimitWindowMs: 60_000 },
    );
    expect(csvAlias3.status).toBe(429);

    const windowStart = Math.floor(aliasWindowNow / 60_000) * 60_000;
    const rlRow = await env.PLATFORM_DB.prepare(
      "SELECT request_count FROM leads_export_rate_limits WHERE bucket_key = ?",
    )
      .bind(`${tenantA.tenantId}:${tenantA.ownerUserId}:${windowStart}`)
      .first<{ readonly request_count: number }>();
    expect(rlRow?.request_count).toBe(2);

    // 6. Resilient platform_audit: transient platform_audit insert failure NEVER blocks owner CSV recovery!
    const flakyAuditDb = new Proxy(env.PLATFORM_DB, {
      get(target, prop, receiver) {
        if (prop === "prepare") {
          return (sql: string) => {
            if (/INSERT\s+INTO\s+platform_audit/i.test(sql)) {
              return {
                bind: () => ({
                  run: async () => {
                    throw new Error("D1_TRANSIENT_AUDIT_ERROR");
                  },
                }),
              };
            }
            return target.prepare(sql);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as D1Database;

    const resilientRes = await handleTenantLeadsExportRequest(
      tenantA.tenantId,
      makeAdminRequest(`/api/tenants/${tenantA.tenantId}/leads/export`, "GET", tenantA.ownerCookie),
      { ...leadsEnv, PLATFORM_DB: flakyAuditDb },
      { nowMs: aliasWindowNow + 120_000, rateLimitMax: 5, rateLimitWindowMs: 60_000 },
    );
    expect(resilientRes.status).toBe(200);
    expect(await resilientRes.text()).toContain("Prospek Uji");
  });

  it("dispatches daily offboarding cron via OFFBOARDING_CRON_JOB_DEFINITIONS and processes it through zero-arg createOffboardingJobRegistry()", async () => {
    const scheduledTime = Date.UTC(2026, 10, 23, 0, 7, 0);
    const queuedEnvelopes: Array<{
      readonly topic: string;
      readonly idempotencyKey: string;
      readonly tenantId: string | null;
      readonly payload?: Record<string, unknown>;
    }> = [];

    const mockQueue = {
      async send(msg: {
        readonly topic: string;
        readonly idempotencyKey: string;
        readonly tenantId: string | null;
        readonly payload?: Record<string, unknown>;
      }) {
        queuedEnvelopes.push(msg);
      },
      async sendBatch() {},
    };

    const dispatchRes = await dispatchScheduledCron(
      {
        cron: DEFAULT_CRON_EXPRESSION,
        scheduledTime,
      },
      {
        PLATFORM_DB: env.PLATFORM_DB,
        JOBS_QUEUE: mockQueue as unknown as Queue,
      },
      [...DEFAULT_CRON_JOB_DEFINITIONS, ...OFFBOARDING_CRON_JOB_DEFINITIONS],
    );

    const offboardingOutcome = dispatchRes.jobs.find(
      (d) => d.topic === TENANT_OFFBOARDING_SWEEP_TOPIC,
    );
    expect(offboardingOutcome?.enqueued).toBe(true);

    const offboardingMsg = queuedEnvelopes.find((m) => m.topic === TENANT_OFFBOARDING_SWEEP_TOPIC);
    expect(offboardingMsg).toBeDefined();
    expect(offboardingMsg?.payload?.scheduledAtMs).toBe(scheduledTime);

    // Execute the enqueued sweep message through the zero-arg registry exactly as wired in worker/index.ts
    const { batch, acked, retried } = buildQueueBatch([
      {
        id: "worker-wired-sweep-1",
        body: {
          idempotencyKey: offboardingMsg!.idempotencyKey,
          topic: offboardingMsg!.topic,
          tenantId: offboardingMsg!.tenantId,
          payload: offboardingMsg!.payload ?? {},
          enqueuedAt: scheduledTime,
        },
      },
    ]);

    const res = await processDurableQueueBatch(
      batch,
      env,
      {
        ...createRetentionJobRegistry(),
        ...createOffboardingJobRegistry(),
      },
      { now: () => scheduledTime },
    );
    expect(res.completed).toBe(1);
    expect(acked.has("worker-wired-sweep-1")).toBe(true);
    expect(retried.size).toBe(0);

    const ledgerRow = await env.PLATFORM_DB.prepare(
      "SELECT status, topic FROM job_ledger WHERE idempotency_key = ?",
    )
      .bind(offboardingMsg!.idempotencyKey)
      .first<{ readonly status: string; readonly topic: string }>();
    expect(ledgerRow?.status).toBe("completed");
    expect(ledgerRow?.topic).toBe(TENANT_OFFBOARDING_SWEEP_TOPIC);
  });

  it("invokes real TenantStore.purgeAll() RPC (deleteAlarm + deleteAll) against the live DO binding", async () => {
    const nowMs = Date.UTC(2026, 10, 23, 2, 0, 0);
    const tenant = await seedTenantFixture({
      handle: "t068-real-do-purge",
      name: "Real DO Purge Co",
      status: "suspended",
      ownerEmail: "owner-real-do@example.com",
      paidThroughMs: nowMs - 50 * DAY_MS,
      createdAtMs: nowMs - 90 * DAY_MS,
      seedTenantStore: true,
    });

    const realStub = env.TENANT_STORE.getByName(tenant.tenantId, { locationHint: "apac-se" });

    // Arm a real Durable Object alarm before purging
    const armed = await realStub.armAlarm(1, 60_000);
    expect(armed.scheduledAt).toBeGreaterThan(0);

    const beforeState = await realStub.schemaState(1);
    expect(beforeState.appliedMigrations.length).toBeGreaterThan(0);

    const method = await purgeTenantStoreData(realStub as unknown as OffboardingTenantStoreStubLike);
    expect(method).toBe("purgeAll");

    const afterState = await realStub.schemaState(1);
    expect(afterState.appliedMigrations).toEqual([]);

    const afterAlarm = await realStub.alarmState(1);
    expect(afterAlarm).toEqual({ runs: 0, lastRunAt: null });
  });

  it("never orphans custom hostnames without cloudflareClient and resumes per-row with 404 idempotency", async () => {
    const createdAt = Date.UTC(2026, 6, 1, 0, 0, 0);
    const paidThrough = Date.UTC(2026, 7, 1, 0, 0, 0);
    const dueAt = paidThrough + PAID_DELETION_WINDOW_MS;

    const tenant = await seedTenantFixture({
      handle: "t068-cf-resumable",
      name: "CF Resumable Co",
      status: "suspended",
      ownerEmail: "owner-cf-res@example.com",
      paidThroughMs: paidThrough,
      createdAtMs: createdAt,
      seedTenantStore: false,
    });

    await env.PLATFORM_DB.batch([
      env.PLATFORM_DB.prepare(
        `INSERT INTO tenant_hosts (
           host, tenant_id, kind, cf_custom_hostname_id, status, ssl_status,
           is_primary, version, created_at, updated_at
         ) VALUES ('a-first.example.id', ?, 'custom', 'cf_host_1', 'active', 'active', 0, 1, ?, ?)`,
      ).bind(tenant.tenantId, createdAt, createdAt),
      env.PLATFORM_DB.prepare(
        `INSERT INTO tenant_hosts (
           host, tenant_id, kind, cf_custom_hostname_id, status, ssl_status,
           is_primary, version, created_at, updated_at
         ) VALUES ('b-second.example.id', ?, 'custom', 'cf_host_2', 'active', 'active', 0, 1, ?, ?)`,
      ).bind(tenant.tenantId, createdAt, createdAt),
    ]);

    const claim = await claimTenantForOffboarding(env.PLATFORM_DB, {
      tenantId: tenant.tenantId,
      nowMs: dueAt,
    });
    expect(claim.claimed).toBe(true);

    // (a) Missing cloudflareClient with active custom hostnames MUST fail without deleting tenant_hosts or checkpointing!
    await expect(
      executeTenantOffboardingPurge({
        platformDb: env.PLATFORM_DB,
        tenantId: tenant.tenantId,
        cloudflareClient: null,
        nowMs: dueAt + 1000,
      }),
    ).rejects.toThrow("CLOUDFLARE_CLIENT_UNAVAILABLE");

    const hostsAfterMissingClient = await env.PLATFORM_DB.prepare(
      "SELECT host FROM tenant_hosts WHERE tenant_id = ? AND kind = 'custom' ORDER BY host ASC",
    )
      .bind(tenant.tenantId)
      .all<{ readonly host: string }>();
    expect(hostsAfterMissingClient.results.map((r) => r.host)).toEqual([
      "a-first.example.id",
      "b-second.example.id",
    ]);
    const runAfterMissing = await getTenantOffboardingRun(env.PLATFORM_DB, tenant.tenantId);
    expect(runAfterMissing?.hostnamesPurgedAtMs).toBeNull();
    expect(runAfterMissing?.lastErrorCode).toBe("CLOUDFLARE_CLIENT_UNAVAILABLE");

    // (b) Mid-loop failure on #2 deletes #1's local row immediately; retry hitting 404 on #2 succeeds cleanly!
    const deletedCalls: string[] = [];
    const flakyCf: OffboardingCloudflareClientLike = {
      async deleteCustomHostname(id: string) {
        deletedCalls.push(id);
        if (id === "cf_host_2") {
          throw new Error("CF_UPSTREAM_503");
        }
        return { deleted: true, alreadyAbsent: false };
      },
    };

    await expect(
      executeTenantOffboardingPurge({
        platformDb: env.PLATFORM_DB,
        tenantId: tenant.tenantId,
        cloudflareClient: flakyCf,
        nowMs: dueAt + 2000,
      }),
    ).rejects.toThrow("CF_UPSTREAM_503");

    // #1 was deleted immediately; only #2 remains in tenant_hosts; step not yet checkpointed
    const remainingHosts = await env.PLATFORM_DB.prepare(
      "SELECT host FROM tenant_hosts WHERE tenant_id = ? AND kind = 'custom' ORDER BY host ASC",
    )
      .bind(tenant.tenantId)
      .all<{ readonly host: string }>();
    expect(remainingHosts.results.map((r) => r.host)).toEqual(["b-second.example.id"]);

    const retryCalls: string[] = [];
    const notFoundCf: OffboardingCloudflareClientLike = {
      async deleteCustomHostname(id: string) {
        retryCalls.push(id);
        const err = new Error("Cloudflare 404 Not Found") as Error & { status: number };
        err.status = 404;
        throw err;
      },
    };

    const resumeRes = await executeTenantOffboardingPurge({
      platformDb: env.PLATFORM_DB,
      tenantId: tenant.tenantId,
      cloudflareClient: notFoundCf,
      nowMs: dueAt + 3000,
    });
    expect(resumeRes.outcome).toBe("purged");
    // Only #2 was retried (never re-calling #1!) and 404 was treated as idempotent success!
    expect(retryCalls).toEqual(["cf_host_2"]);

    const hostsAfterComplete = await env.PLATFORM_DB.prepare(
      "SELECT COUNT(*) AS cnt FROM tenant_hosts WHERE tenant_id = ?",
    )
      .bind(tenant.tenantId)
      .first<{ readonly cnt: number }>();
    expect(Number(hostsAfterComplete?.cnt ?? 0)).toBe(0);
  });

  it("paginates sweep candidates via keyset cursor and skips healthy active paid tenants in SQL (zero starvation)", async () => {
    const nowMs = Date.UTC(2026, 10, 23, 12, 0, 0);
    const healthyPaidThrough = nowMs + 30 * DAY_MS;

    // Seed 5 healthy active paid tenants (with deletion_due_at = paid_through + 45d)
    const healthyIds: string[] = [];
    for (let i = 1; i <= 5; i += 1) {
      const h = await seedTenantFixture({
        handle: `t068-healthy-${i}`,
        name: `Healthy Active ${i}`,
        status: "active",
        ownerEmail: `healthy-${i}@example.com`,
        paidThroughMs: healthyPaidThrough,
        deletionDueAtMs: healthyPaidThrough + PAID_DELETION_WINDOW_MS,
        createdAtMs: nowMs - 10 * DAY_MS,
        seedTenantStore: false,
      });
      healthyIds.push(h.tenantId);
    }

    // Seed 3 due suspended tenants (lexicographically after the healthy ones)
    const dueIds: string[] = [];
    for (let i = 1; i <= 3; i += 1) {
      const t = await seedTenantFixture({
        handle: `t068-due-paged-${i}`,
        name: `Due Paged ${i}`,
        status: "suspended",
        ownerEmail: `due-paged-${i}@example.com`,
        paidThroughMs: nowMs - 50 * DAY_MS,
        createdAtMs: nowMs - 90 * DAY_MS,
        seedTenantStore: false,
      });
      dueIds.push(t.tenantId);
    }

    // Verify SQL candidate filter excludes ALL 5 healthy active paid tenants!
    const candidates = await listTenantsForOffboardingSweep(env.PLATFORM_DB, {
      limit: 500,
      nowMs,
    });
    const candidateIdSet = new Set(candidates.map((c) => c.id));
    for (const hId of healthyIds) {
      expect(candidateIdSet.has(hId)).toBe(false);
    }
    for (const dId of dueIds) {
      expect(candidateIdSet.has(dId)).toBe(true);
    }

    // Sweep with small pageSize=2 to prove multi-page keyset traversal purges ALL trailing due tenants!
    const sweepRes = await runTenantOffboardingSweep(
      { PLATFORM_DB: env.PLATFORM_DB },
      { nowMs, pageSize: 2, emailPort: null },
    );

    expect(sweepRes.scannedTenants).toBeGreaterThanOrEqual(3);
    expect(sweepRes.tenantsPurged).toBeGreaterThanOrEqual(3);
    for (const id of dueIds) {
      const row = await env.PLATFORM_DB.prepare("SELECT status FROM tenants WHERE id = ?")
        .bind(id)
        .first<{ readonly status: string }>();
      expect(row?.status).toBe("purged");
    }
    for (const hId of healthyIds) {
      const row = await env.PLATFORM_DB.prepare("SELECT status FROM tenants WHERE id = ?")
        .bind(hId)
        .first<{ readonly status: string }>();
      expect(row?.status).toBe("active");
    }
  });
});

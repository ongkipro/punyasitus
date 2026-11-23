import {
  DEFAULT_PLUGIN_HOOK_TIMEOUT_MS,
  isBuiltinPluginId,
  PluginHookEventSchema,
  type PluginHookEvent,
} from "@punyasitus/core/plugins/index";
import { sanitizeErrorCode } from "@punyasitus/core/jobs/index";
import {
  createTenantDb,
  openTenantStoreStub,
  type TenantStoreNamespaceLike,
} from "@punyasitus/db/connections";
import { enqueueDurableJob } from "@punyasitus/db/jobs/index";
import {
  createScopedPluginTenantDb,
  getActiveTenantPluginEntitlement,
  getInstalledPlugin,
  listActiveTenantPluginEntitlements,
  type ScopedPluginTenantDbOptions,
} from "@punyasitus/db/plugins/index";
import { DEFAULT_PLUGIN_REGISTRY, type PluginRegistry } from "../../../core/plugin-registry.ts";
import type { DurableJobHandler, DurableJobRegistry, JobExecutionContext } from "../consumer.ts";

/**
 * Fault-Isolated Plugin Queue Hook Dispatcher (Slot 4; REQ-097, ADR-0010, PLAN §19.7).
 *
 * Critical Invariants:
 * 1. Core CMS writes (lead creation, post/offering publish) NEVER wait on, depend on,
 *    or roll back because of a plugin hook failure, exception, or timeout.
 * 2. Unentitled tenants short-circuit on `PLATFORM_DB.tenant_plugin_entitlements` with
 *    ZERO `TenantStore` queries.
 * 3. Every plugin hook runs with a namespace-locked `PluginTenantDb` (`plg_<id>__*`)
 *    and a strict per-plugin timeout ceiling.
 */

export const PLUGIN_HOOK_QUEUE_TOPIC = "plugin.hook.dispatch" as const;

const HOOK_ALLOWED_TENANT_STATUSES = new Set(["trial", "active", "grace", "locked"]);

export interface PluginHookEnqueueDeps {
  readonly platformDb: D1Database;
  readonly queue?: { readonly send: (message: unknown) => Promise<unknown> } | null;
  readonly registry?: PluginRegistry;
  readonly nowMs?: number;
}

export interface PluginHookEnqueueResult {
  readonly enqueued: number;
  readonly pluginIds: readonly string[];
  readonly failedEnqueue: boolean;
}

/**
 * Enqueues fault-isolated plugin hook jobs for an already-committed core CMS domain event.
 * Wrapped in a hard fault boundary so even D1/Queue hiccups NEVER propagate back to
 * the core CMS write path.
 */
export async function enqueuePluginDomainEvent(
  deps: PluginHookEnqueueDeps,
  input: {
    readonly tenantId: string;
    readonly event: PluginHookEvent;
    readonly eventId: string;
    readonly payload: Readonly<Record<string, unknown>>;
    readonly correlationId?: string | null;
  },
): Promise<PluginHookEnqueueResult> {
  try {
    const registry = deps.registry ?? DEFAULT_PLUGIN_REGISTRY;
    const subscribers = registry.findByQueueHook(input.event);
    if (subscribers.length === 0) {
      return { enqueued: 0, pluginIds: [], failedEnqueue: false };
    }

    const nowMs = Math.floor(deps.nowMs ?? Date.now());
    const activeEntitlements = await listActiveTenantPluginEntitlements(
      deps.platformDb,
      input.tenantId,
      nowMs,
    );
    if (activeEntitlements.length === 0) {
      // ZERO TenantStore queries, zero Queue messages for unentitled tenants
      return { enqueued: 0, pluginIds: [], failedEnqueue: false };
    }

    const entitledIds = new Set(activeEntitlements.map((e) => e.pluginId));
    const matchedIds: string[] = [];

    for (const def of subscribers) {
      if (!entitledIds.has(def.manifest.id)) continue;
      const idempotencyKey = `plg-hook:${input.tenantId}:${def.manifest.id}:${input.event}:${input.eventId}`;
      const jobPayload = {
        pluginId: def.manifest.id,
        event: input.event,
        eventId: input.eventId,
        data: input.payload,
      };

      await enqueueDurableJob(deps.platformDb, {
        idempotencyKey,
        topic: PLUGIN_HOOK_QUEUE_TOPIC,
        tenantId: input.tenantId,
        payload: jobPayload,
        nowMs,
      });

      if (deps.queue) {
        await deps.queue.send({
          idempotencyKey,
          topic: PLUGIN_HOOK_QUEUE_TOPIC,
          tenantId: input.tenantId,
          payload: jobPayload,
          correlationId: input.correlationId ?? null,
          enqueuedAt: nowMs,
        });
      }

      matchedIds.push(def.manifest.id);
    }

    return {
      enqueued: matchedIds.length,
      pluginIds: matchedIds,
      failedEnqueue: false,
    };
  } catch {
    // Hard fault isolation: plugin hook enqueue errors NEVER break core CMS writes
    return { enqueued: 0, pluginIds: [], failedEnqueue: true };
  }
}

export interface DispatchPluginHookDeps {
  readonly platformDb: D1Database;
  readonly tenantStore?: TenantStoreNamespaceLike | null;
  readonly resolveTenantDb?: (tenantId: string) => D1Database;
  readonly registry?: PluginRegistry;
  readonly nowMs?: number;
  readonly scopedDbOptions?: ScopedPluginTenantDbOptions;
}

export interface PluginHookDispatchOutcome {
  readonly pluginId: string;
  readonly event: PluginHookEvent;
  readonly eventId: string;
  readonly outcome:
    | "completed"
    | "skipped_not_found"
    | "skipped_tenant_unavailable"
    | "skipped_unentitled"
    | "skipped_disabled"
    | "failed"
    | "timed_out";
  readonly errorCode?: string;
  readonly durationMs: number;
}

function runWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("PLUGIN_HOOK_TIMEOUT"));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Executes a single plugin hook inside a strict fault-isolation and timeout boundary.
 * NEVER throws uncaught exceptions into callers or core CMS transactions.
 */
export async function dispatchPluginHookIsolated(
  deps: DispatchPluginHookDeps,
  input: {
    readonly tenantId: string;
    readonly pluginId: string;
    readonly event: PluginHookEvent;
    readonly eventId: string;
    readonly payload: Readonly<Record<string, unknown>>;
    readonly timeoutMs?: number;
  },
): Promise<PluginHookDispatchOutcome> {
  const startedAt = Date.now();
  const base = {
    pluginId: input.pluginId,
    event: input.event,
    eventId: input.eventId,
  };

  if (!input.pluginId || isBuiltinPluginId(input.pluginId)) {
    return { ...base, outcome: "skipped_not_found", durationMs: Date.now() - startedAt };
  }

  const registry = deps.registry ?? DEFAULT_PLUGIN_REGISTRY;
  const plugin = registry.get(input.pluginId);
  const hook = plugin?.queueHooks?.[input.event];
  if (!plugin || !hook) {
    return { ...base, outcome: "skipped_not_found", durationMs: Date.now() - startedAt };
  }

  const nowMs = Math.floor(deps.nowMs ?? Date.now());

  try {
    const tenantRow = await deps.platformDb
      .prepare("SELECT status, operator_hold FROM tenants WHERE id = ? LIMIT 1")
      .bind(input.tenantId)
      .first<{ readonly status: string; readonly operator_hold: number }>();

    if (
      !tenantRow ||
      tenantRow.operator_hold === 1 ||
      !HOOK_ALLOWED_TENANT_STATUSES.has(tenantRow.status)
    ) {
      return {
        ...base,
        outcome: "skipped_tenant_unavailable",
        durationMs: Date.now() - startedAt,
      };
    }

    const entitlement = await getActiveTenantPluginEntitlement(
      deps.platformDb,
      input.tenantId,
      plugin.manifest.id,
      nowMs,
    );
    if (!entitlement) {
      // ZERO TenantStore queries executed!
      return { ...base, outcome: "skipped_unentitled", durationMs: Date.now() - startedAt };
    }

    const tenantDb = deps.resolveTenantDb
      ? deps.resolveTenantDb(input.tenantId)
      : deps.tenantStore
        ? createTenantDb(openTenantStoreStub(deps.tenantStore, input.tenantId))
        : null;

    if (!tenantDb) {
      return {
        ...base,
        outcome: "failed",
        errorCode: "TENANT_STORE_UNAVAILABLE",
        durationMs: Date.now() - startedAt,
      };
    }

    const installed = await getInstalledPlugin(tenantDb, plugin.manifest.id);
    if (!installed || !installed.enabled) {
      return { ...base, outcome: "skipped_disabled", durationMs: Date.now() - startedAt };
    }

    const scopedDb = createScopedPluginTenantDb(
      plugin.manifest.id,
      tenantDb,
      deps.scopedDbOptions,
    );

    const effectiveTimeoutMs = Math.min(
      30_000,
      Math.max(50, input.timeoutMs ?? hook.timeoutMs ?? DEFAULT_PLUGIN_HOOK_TIMEOUT_MS),
    );

    await runWithTimeout(
      hook.execute({
        tenantId: input.tenantId,
        pluginId: plugin.manifest.id,
        event: input.event,
        eventId: input.eventId,
        payload: input.payload,
        config: installed.config,
        db: scopedDb,
        nowMs,
      }),
      effectiveTimeoutMs,
    );

    return {
      ...base,
      outcome: "completed",
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    const isTimeout = err instanceof Error && err.message === "PLUGIN_HOOK_TIMEOUT";
    return {
      ...base,
      outcome: isTimeout ? "timed_out" : "failed",
      errorCode: isTimeout ? "PLUGIN_HOOK_TIMEOUT" : sanitizeErrorCode(err),
      durationMs: Date.now() - startedAt,
    };
  }
}

/**
 * Runs a core CMS write atomically first, then dispatches entitled subscribed plugin hooks
 * inside a hard fault-isolation boundary so ANY plugin/hook preparation, enqueue, or
 * execution failure NEVER throws or rolls back the committed core write (REQ-097).
 *
 * When `queue` is provided, hooks are enqueued asynchronously onto Cloudflare Queues
 * (zero synchronous blocking of core CMS requests). Otherwise, runs inline with
 * concurrent fault-isolated execution per plugin.
 */
export async function runCoreWriteWithIsolatedPluginHooks<TResult>(input: {
  readonly coreWrite: () => Promise<TResult>;
  readonly tenantId: string;
  readonly event: PluginHookEvent;
  readonly eventId: (coreResult: TResult) => string;
  readonly buildPayload: (coreResult: TResult) => Readonly<Record<string, unknown>>;
  readonly hookDeps: DispatchPluginHookDeps;
  readonly queue?: { readonly send: (message: unknown) => Promise<unknown> } | null;
}): Promise<{
  readonly coreResult: TResult;
  readonly hookOutcomes: readonly PluginHookDispatchOutcome[];
  readonly enqueuedCount: number;
}> {
  // 1. Core CMS transaction commits first — completely independent of any plugin code
  const coreResult = await input.coreWrite();

  // 2. Hard fault-isolation boundary: NOTHING past core commit may throw!
  try {
    const registry = input.hookDeps.registry ?? DEFAULT_PLUGIN_REGISTRY;
    const subscribers = registry.findByQueueHook(input.event);
    if (subscribers.length === 0) {
      return { coreResult, hookOutcomes: [], enqueuedCount: 0 };
    }

    const eventId = input.eventId(coreResult);
    const payload = input.buildPayload(coreResult);

    if (input.queue) {
      const enq = await enqueuePluginDomainEvent(
        {
          platformDb: input.hookDeps.platformDb,
          queue: input.queue,
          registry,
          nowMs: input.hookDeps.nowMs,
        },
        {
          tenantId: input.tenantId,
          event: input.event,
          eventId,
          payload,
        },
      );
      return { coreResult, hookOutcomes: [], enqueuedCount: enq.enqueued };
    }

    const activeEntitlements = await listActiveTenantPluginEntitlements(
      input.hookDeps.platformDb,
      input.tenantId,
      Math.floor(input.hookDeps.nowMs ?? Date.now()),
    );
    const entitledIds = new Set(activeEntitlements.map((e) => e.pluginId));
    if (entitledIds.size === 0) {
      return { coreResult, hookOutcomes: [], enqueuedCount: 0 };
    }

    const entitledSubscribers = subscribers.filter((def) => entitledIds.has(def.manifest.id));
    const hookOutcomes = await Promise.all(
      entitledSubscribers.map((def) =>
        dispatchPluginHookIsolated(input.hookDeps, {
          tenantId: input.tenantId,
          pluginId: def.manifest.id,
          event: input.event,
          eventId,
          payload,
        }),
      ),
    );

    return { coreResult, hookOutcomes, enqueuedCount: 0 };
  } catch {
    return { coreResult, hookOutcomes: [], enqueuedCount: 0 };
  }
}

/**
 * Durable Cloudflare Queue consumer handler for `plugin.hook.dispatch`
 * compatible with `processDurableQueueBatch` (`apps/web/src/worker/queues/consumer.ts`).
 */
export function createPluginHookQueueHandler(options?: {
  readonly registry?: PluginRegistry;
  readonly resolveTenantDb?: (tenantId: string) => D1Database;
  readonly scopedDbOptions?: ScopedPluginTenantDbOptions;
}): DurableJobHandler {
  return {
    maxAttempts: 3,
    leaseDurationMs: 30_000,
    async execute(ctx: JobExecutionContext): Promise<void> {
      const tenantId = ctx.tenantId;
      if (!tenantId) return;

      const rawPluginId = typeof ctx.payload.pluginId === "string" ? ctx.payload.pluginId : "";
      const rawEvent = PluginHookEventSchema.safeParse(ctx.payload.event);
      const rawEventId = typeof ctx.payload.eventId === "string" ? ctx.payload.eventId : ctx.idempotencyKey;
      const data =
        ctx.payload.data && typeof ctx.payload.data === "object" && !Array.isArray(ctx.payload.data)
          ? (ctx.payload.data as Record<string, unknown>)
          : {};

      if (!rawPluginId || !rawEvent.success) return;

      const outcome = await dispatchPluginHookIsolated(
        {
          platformDb: ctx.env.PLATFORM_DB,
          tenantStore: ctx.env.TENANT_STORE as unknown as TenantStoreNamespaceLike | undefined,
          resolveTenantDb: options?.resolveTenantDb,
          registry: options?.registry ?? DEFAULT_PLUGIN_REGISTRY,
          nowMs: ctx.nowMs,
          scopedDbOptions: options?.scopedDbOptions,
        },
        {
          tenantId,
          pluginId: rawPluginId,
          event: rawEvent.data,
          eventId: rawEventId,
          payload: data,
        },
      );

      // On transient failure/timeout inside the async Queue worker, throw so `processDurableQueueBatch`
      // records retry backoff / dead-letter cleanly (core CMS write is ALREADY committed!)
      if (outcome.outcome === "failed" || outcome.outcome === "timed_out") {
        throw new Error(outcome.errorCode ?? "PLUGIN_HOOK_EXECUTION_FAILED");
      }
    },
  };
}

/**
 * Builds the plugin Queue handler registry wired into `WORKER_JOB_REGISTRY`
 * in `apps/web/src/worker/index.ts`.
 */
export function createPluginJobRegistry(options?: {
  readonly registry?: PluginRegistry;
  readonly resolveTenantDb?: (tenantId: string) => D1Database;
  readonly scopedDbOptions?: ScopedPluginTenantDbOptions;
}): DurableJobRegistry {
  return {
    [PLUGIN_HOOK_QUEUE_TOPIC]: createPluginHookQueueHandler(options),
  };
}

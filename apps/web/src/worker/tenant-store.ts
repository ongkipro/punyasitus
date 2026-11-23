import { DurableObject } from "cloudflare:workers";
import {
  TenantStoreEngine,
  type SchemaState,
  type StatementDescriptor,
  type StatementResult,
  type StorageLike,
} from "@punyasitus/db/connections";
import type { PunyasitusEnv } from "./env.d.ts";

const ALARM_RUNS_KEY = "ps:alarm:runs";
const ALARM_LAST_AT_KEY = "ps:alarm:last_at";

/**
 * Per-tenant SQLite Durable Object (`ADR-0009`, `DEC-036`).
 * The constructor only initializes the engine handle (never runs migrations);
 * all SQL access flows through protocol-checked RPC methods and `transactionSync`.
 */
export class TenantStore extends DurableObject<PunyasitusEnv> {
  #engine: TenantStoreEngine | undefined;

  constructor(ctx: DurableObjectState, env: PunyasitusEnv) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      this.#engine = new TenantStoreEngine(ctx.storage as unknown as StorageLike);
    });
  }

  get #store(): TenantStoreEngine {
    if (!this.#engine) {
      throw new Error("TENANT_STORE_NOT_READY");
    }
    return this.#engine;
  }

  async query(
    protocol: number,
    statement: StatementDescriptor,
    raw: boolean,
  ): Promise<StatementResult> {
    this.#store.checkProtocol(protocol);
    return this.#store.query(statement, raw);
  }

  async batch(
    protocol: number,
    statements: StatementDescriptor[],
  ): Promise<StatementResult[]> {
    this.#store.checkProtocol(protocol);
    return this.#store.batch(statements);
  }

  async schemaState(protocol: number): Promise<SchemaState> {
    this.#store.checkProtocol(protocol);
    return this.#store.schemaState();
  }

  async armAlarm(protocol: number, delayMs = 60_000): Promise<{ scheduledAt: number }> {
    this.#store.checkProtocol(protocol);
    const scheduledAt = Date.now() + Math.max(100, delayMs);
    await this.ctx.storage.setAlarm(scheduledAt);
    return { scheduledAt };
  }

  async alarmState(protocol: number): Promise<{ runs: number; lastRunAt: number | null }> {
    this.#store.checkProtocol(protocol);
    const runs = (await this.ctx.storage.get<number>(ALARM_RUNS_KEY)) ?? 0;
    const lastRunAt = (await this.ctx.storage.get<number>(ALARM_LAST_AT_KEY)) ?? null;
    return { runs, lastRunAt };
  }

  /**
   * Irreversible DEC-022 tenant purge RPC: cancels any pending DO alarm and wipes all
   * SQLite and KV storage belonging to this tenant's Durable Object.
   */
  async purgeAll(protocol: number): Promise<{ readonly purged: true }> {
    this.#store.checkProtocol(protocol);
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    return { purged: true };
  }

  override async alarm(): Promise<void> {
    const runs = ((await this.ctx.storage.get<number>(ALARM_RUNS_KEY)) ?? 0) + 1;
    await this.ctx.storage.put(ALARM_RUNS_KEY, runs);
    await this.ctx.storage.put(ALARM_LAST_AT_KEY, Date.now());
  }
}

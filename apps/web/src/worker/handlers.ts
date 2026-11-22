import type { JobQueuePayload, PunyasitusEnv } from "./env.d.ts";

/**
 * Shared Queue consumer and Cron handler logic, kept free of Astro bundle
 * imports so both the production Worker entry (`index.ts`) and `workerd`
 * Vitest integration tests exercise the exact same code.
 */
async function ensureProbeLedger(db: D1Database): Promise<void> {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS _bootstrap_job_ledger (
        idempotency_key TEXT PRIMARY KEY,
        topic TEXT NOT NULL,
        tenant_id TEXT,
        processed_at TEXT NOT NULL
      )`,
    )
    .run();
}

async function ensureCronLedger(db: D1Database): Promise<void> {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS _bootstrap_cron_ticks (
        cron TEXT NOT NULL,
        scheduled_time INTEGER NOT NULL,
        recorded_at TEXT NOT NULL,
        PRIMARY KEY (cron, scheduled_time)
      )`,
    )
    .run();
}

export async function handleQueueBatch(
  batch: MessageBatch<JobQueuePayload>,
  env: Pick<PunyasitusEnv, "PLATFORM_DB">,
): Promise<{ processed: number }> {
  await ensureProbeLedger(env.PLATFORM_DB);
  let processed = 0;
  for (const message of batch.messages) {
    const body = message.body;
    await env.PLATFORM_DB.prepare(
      `INSERT OR IGNORE INTO _bootstrap_job_ledger
        (idempotency_key, topic, tenant_id, processed_at)
       VALUES (?, ?, ?, ?)`,
    )
      .bind(body.idempotencyKey, body.topic, body.tenantId ?? null, new Date().toISOString())
      .run();
    message.ack();
    processed += 1;
  }
  return { processed };
}

export async function handleScheduledTick(
  controller: ScheduledController,
  env: Pick<PunyasitusEnv, "PLATFORM_DB">,
): Promise<{ cron: string; scheduledTime: number }> {
  await ensureCronLedger(env.PLATFORM_DB);
  await env.PLATFORM_DB.prepare(
    `INSERT OR IGNORE INTO _bootstrap_cron_ticks
      (cron, scheduled_time, recorded_at)
     VALUES (?, ?, ?)`,
  )
    .bind(controller.cron, controller.scheduledTime, new Date().toISOString())
    .run();
  return { cron: controller.cron, scheduledTime: controller.scheduledTime };
}

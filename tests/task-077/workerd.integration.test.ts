import { createMessageBatch } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { createReceiptPdfBytes } from "@punyasitus/core";
import {
  ALLOWED_EMAIL_SENDER,
  createCloudflareEmailAdapter,
  createLocalMailSink,
  encodeBytesToBase64,
  type CloudflareSendEmailPayload,
} from "@punyasitus/core/email/index";
import { applyPlatformMigrations } from "@punyasitus/db/connections";
import {
  EMAIL_CLAIMS_MIGRATION,
  claimEmailDelivery,
  getEmailDeliveryClaim,
  getEmailSuppression,
  getSuppressionNoticeForOwner,
  hashEmailAddress,
  isEmailSuppressed,
} from "@punyasitus/db/email/index";
import { getJobLedgerRecord } from "@punyasitus/db/jobs/index";
import { PLATFORM_MIGRATIONS } from "@punyasitus/db/platform";
import { beforeAll, describe, expect, it } from "vitest";
import {
  handleEmailBounceWebhook,
  signEmailWebhookPayload,
} from "../../apps/web/src/pages/api/webhooks/email/bounce-handler.ts";
import {
  processDurableQueueBatch,
  type DeadLetterRecord,
  type DurableJobRegistry,
} from "../../apps/web/src/worker/queues/consumer.ts";
import {
  EMAIL_DELIVERY_TOPIC,
  enqueueTransactionalEmail,
} from "../../apps/web/src/worker/queues/dispatch/email.ts";
import {
  createEmailQueueHandler,
  type EmailSuppressionNoticeEvent,
} from "../../apps/web/src/worker/queues/email/handler.ts";
import { SYNTHETIC_TENANTS } from "../fixtures/tenants.ts";

interface TrackedMessageOutcome {
  readonly id: string;
  acked: boolean;
  retries: Array<{ delaySeconds?: number }>;
}

function buildTrackedBatch(
  messages: readonly { id: string; body: unknown; attempts?: number }[],
): {
  batch: MessageBatch<unknown>;
  outcomes: Map<string, TrackedMessageOutcome>;
} {
  const rawBatch = createMessageBatch(
    "punyasitus-jobs-test",
    messages.map((m) => ({
      id: m.id,
      timestamp: new Date(),
      body: m.body,
      attempts: m.attempts ?? 1,
    })),
  );

  const outcomes = new Map<string, TrackedMessageOutcome>();
  const wrappedMessages = rawBatch.messages.map((msg) => {
    const tracker: TrackedMessageOutcome = {
      id: msg.id,
      acked: false,
      retries: [],
    };
    outcomes.set(msg.id, tracker);

    return {
      id: msg.id,
      timestamp: msg.timestamp,
      body: msg.body,
      attempts: msg.attempts,
      ack() {
        tracker.acked = true;
        msg.ack();
      },
      retry(opts?: QueueRetryOptions) {
        tracker.retries.push({ delaySeconds: opts?.delaySeconds });
        msg.retry(opts);
      },
    } as Message<unknown>;
  });

  const batch: MessageBatch<unknown> = {
    queue: rawBatch.queue,
    metadata: rawBatch.metadata,
    messages: wrappedMessages,
    ackAll: () => rawBatch.ackAll(),
    retryAll: (opts?: QueueRetryOptions) => rawBatch.retryAll(opts),
  };

  return { batch, outcomes };
}

describe("TASK-077 Transactional Email Adapter, Claims, Suppression & Webhook (workerd)", () => {
  beforeAll(async () => {
    await applyPlatformMigrations(env.PLATFORM_DB, [
      ...PLATFORM_MIGRATIONS,
      EMAIL_CLAIMS_MIGRATION,
    ]);
  });

  it("enforces zero recipient/body columns in email_delivery_claims schema", async () => {
    const cols = await env.PLATFORM_DB.prepare("PRAGMA table_info(email_delivery_claims)").all<{
      name: string;
    }>();
    const names = cols.results.map((c) => c.name);
    expect(names).toEqual([
      "message_key",
      "template",
      "one_shot",
      "status",
      "provider",
      "error_code",
      "attempts",
      "created_at",
      "updated_at",
    ]);
    for (const forbidden of ["recipient", "email", "to", "body", "html", "text", "subject"]) {
      expect(names).not.toContain(forbidden);
    }
  });

  it("deduplicates enqueue by messageKey, delivers Base64 PDF receipt via mocked env.EMAIL.send(), and records submitted claim without PII", async () => {
    const queuedEnvelopes: unknown[] = [];
    const sentPayloads: CloudflareSendEmailPayload[] = [];
    const pdfBytes = await createReceiptPdfBytes({
      receiptNumber: "PS-2026-000101",
      tenantName: SYNTHETIC_TENANTS[0].siteTitle,
      amountIdr: 199000,
    });
    const expectedBase64 = encodeBytesToBase64(pdfBytes);

    const dispatchEnv = {
      PLATFORM_DB: env.PLATFORM_DB,
      JOBS_QUEUE: {
        async send(body: unknown) {
          queuedEnvelopes.push(body);
        },
      },
    };

    const firstEnqueue = await enqueueTransactionalEmail(dispatchEnv, {
      messageKey: "receipt:PS-2026-000101",
      template: "billing-receipt",
      to: "owner-alpha@example.com",
      tenantId: SYNTHETIC_TENANTS[0].id,
      templateData: {
        recipientName: "Pemilik Alpha",
        tenantName: SYNTHETIC_TENANTS[0].siteTitle,
        receiptNumber: "PS-2026-000101",
        amountIdr: 199000,
        paidAtLabel: "22 November 2026",
        paymentChannel: "QRIS",
      },
      attachments: [
        {
          filename: "kwitansi-PS-2026-000101.pdf",
          contentType: "application/pdf",
          content: pdfBytes,
        },
      ],
      nowMs: 1_763_820_000_000,
    });
    expect(firstEnqueue).toEqual({
      enqueued: true,
      messageKey: "receipt:PS-2026-000101",
      topic: EMAIL_DELIVERY_TOPIC,
    });

    // Duplicate enqueue with same messageKey is a safe no-op
    const dupEnqueue = await enqueueTransactionalEmail(dispatchEnv, {
      messageKey: "receipt:PS-2026-000101",
      template: "billing-receipt",
      to: "owner-alpha@example.com",
      tenantId: SYNTHETIC_TENANTS[0].id,
      templateData: {
        tenantName: SYNTHETIC_TENANTS[0].siteTitle,
        receiptNumber: "PS-2026-000101",
        amountIdr: 199000,
        paidAtLabel: "22 November 2026",
      },
      nowMs: 1_763_820_001_000,
    });
    expect(dupEnqueue.enqueued).toBe(false);
    expect(queuedEnvelopes).toHaveLength(1);

    const cfAdapter = createCloudflareEmailAdapter({
      async send(msg) {
        sentPayloads.push(msg);
        return { messageId: "cf-receipt-101" };
      },
    });
    const registry: DurableJobRegistry = {
      [EMAIL_DELIVERY_TOPIC]: createEmailQueueHandler({
        emailPort: cfAdapter,
        now: () => 1_763_820_002_000,
      }),
    };

    const { batch, outcomes } = buildTrackedBatch([
      { id: "m-rcpt-1", body: queuedEnvelopes[0], attempts: 1 },
      { id: "m-rcpt-2", body: queuedEnvelopes[0], attempts: 2 },
    ]);
    const res = await processDurableQueueBatch(batch, env, registry, {
      now: () => 1_763_820_002_000,
      logger: () => {},
    });

    expect(res.completed).toBe(1);
    expect(res.deduplicated).toBe(1);
    expect(outcomes.get("m-rcpt-1")?.acked).toBe(true);
    expect(outcomes.get("m-rcpt-2")?.acked).toBe(true);
    expect(sentPayloads).toHaveLength(1);
    expect(sentPayloads[0]?.from).toBe(ALLOWED_EMAIL_SENDER);
    expect(sentPayloads[0]?.attachments?.[0]).toEqual({
      disposition: "attachment",
      filename: "kwitansi-PS-2026-000101.pdf",
      type: "application/pdf",
      content: expectedBase64,
    });

    const claim = await getEmailDeliveryClaim(env.PLATFORM_DB, "receipt:PS-2026-000101");
    expect(claim).toMatchObject({
      messageKey: "receipt:PS-2026-000101",
      template: "billing-receipt",
      oneShot: true,
      status: "submitted",
      provider: "cloudflare",
      errorCode: null,
      attempts: 1,
    });
  });

  it("handles E_RECIPIENT_SUPPRESSED by adding suppression hash, emitting owner notice, skipping without retry, and blocking future sends", async () => {
    const notices: EmailSuppressionNoticeEvent[] = [];
    let sendCalls = 0;

    const cfAdapter = createCloudflareEmailAdapter({
      async send() {
        sendCalls += 1;
        throw Object.assign(new Error("E_RECIPIENT_SUPPRESSED: recipient on suppression list"), {
          code: "E_RECIPIENT_SUPPRESSED",
        });
      },
    });

    const registry: DurableJobRegistry = {
      [EMAIL_DELIVERY_TOPIC]: createEmailQueueHandler({
        emailPort: cfAdapter,
        suppressionSalt: "test-salt-v1",
        now: () => 1_763_821_000_000,
        onOwnerSuppressionNotice(evt) {
          notices.push(evt);
        },
      }),
    };

    const targetEmail = "suppressed-owner@example.com";
    const firstBatch = buildTrackedBatch([
      {
        id: "m-supp-1",
        body: {
          idempotencyKey: "domain-notice:supp-001",
          topic: EMAIL_DELIVERY_TOPIC,
          tenantId: SYNTHETIC_TENANTS[0].id,
          payload: {
            messageKey: "domain-notice:supp-001",
            template: "domain-notice",
            to: targetEmail,
            templateData: {
              tenantName: SYNTHETIC_TENANTS[0].siteTitle,
              domain: "alpha.example.id",
              status: "verified",
            },
          },
        },
      },
    ]);

    const res1 = await processDurableQueueBatch(firstBatch.batch, env, registry, {
      now: () => 1_763_821_000_000,
      logger: () => {},
    });

    expect(res1.completed).toBe(1);
    expect(res1.retried).toBe(0);
    expect(sendCalls).toBe(1);
    expect(firstBatch.outcomes.get("m-supp-1")?.acked).toBe(true);

    // Verify suppression stored as SHA-256 hash only
    const suppressed = await isEmailSuppressed(env.PLATFORM_DB, targetEmail, {
      salt: "test-salt-v1",
    });
    expect(suppressed).toBe(true);
    const expectedHash = await hashEmailAddress(targetEmail, { salt: "test-salt-v1" });
    const rawRow = await getEmailSuppression(env.PLATFORM_DB, targetEmail, {
      salt: "test-salt-v1",
    });
    expect(rawRow?.emailHash).toBe(expectedHash);
    expect(rawRow?.reason).toBe("hard_bounce");

    // Verify claim marked `skipped` with E_RECIPIENT_SUPPRESSED
    const claim1 = await getEmailDeliveryClaim(env.PLATFORM_DB, "domain-notice:supp-001");
    expect(claim1?.status).toBe("skipped");
    expect(claim1?.errorCode).toBe("E_RECIPIENT_SUPPRESSED");

    // Verify visible Bahasa Indonesia owner notice emitted & queryable
    expect(notices).toHaveLength(1);
    expect(notices[0]?.notice.severity).toBe("warning");
    expect(notices[0]?.notice.maskedEmail).toBe("su***@example.com");
    const queriedNotice = await getSuppressionNoticeForOwner(env.PLATFORM_DB, targetEmail, {
      salt: "test-salt-v1",
    });
    expect(queriedNotice?.title).toContain("dihentikan");
    expect(queriedNotice?.message).toContain("tetap normal");

    // Second email to the same suppressed address is skipped BEFORE calling env.EMAIL.send()
    const secondBatch = buildTrackedBatch([
      {
        id: "m-supp-2",
        body: {
          idempotencyKey: "domain-notice:supp-002",
          topic: EMAIL_DELIVERY_TOPIC,
          tenantId: SYNTHETIC_TENANTS[0].id,
          payload: {
            messageKey: "domain-notice:supp-002",
            template: "domain-notice",
            to: targetEmail,
            templateData: {
              tenantName: SYNTHETIC_TENANTS[0].siteTitle,
              domain: "alpha.example.id",
              status: "ssl_active",
            },
          },
        },
      },
    ]);
    await processDurableQueueBatch(secondBatch.batch, env, registry, {
      now: () => 1_763_821_005_000,
      logger: () => {},
    });
    expect(sendCalls).toBe(1); // Still 1 — provider never called again!
    expect(notices).toHaveLength(2);
    const claim2 = await getEmailDeliveryClaim(env.PLATFORM_DB, "domain-notice:supp-002");
    expect(claim2?.status).toBe("skipped");
    expect(claim2?.attempts).toBe(0);
  });

  it("retries E_RATE_LIMITED with bounded backoff and dead-letters once maxAttempts are exhausted", async () => {
    let transientCalls = 0;
    const recoveringAdapter = createCloudflareEmailAdapter({
      async send() {
        transientCalls += 1;
        if (transientCalls === 1) {
          throw Object.assign(new Error("E_RATE_LIMITED: slow down"), { code: "E_RATE_LIMITED" });
        }
        return { messageId: "cf-recovered-2" };
      },
    });

    const registry: DurableJobRegistry = {
      [EMAIL_DELIVERY_TOPIC]: createEmailQueueHandler({
        emailPort: recoveringAdapter,
        maxAttempts: 3,
        now: () => 1_763_822_000_000,
      }),
    };

    const envelope = {
      idempotencyKey: "rate-limit-recover-001",
      topic: EMAIL_DELIVERY_TOPIC,
      tenantId: SYNTHETIC_TENANTS[0].id,
      payload: {
        messageKey: "rate-limit-recover-001",
        template: "domain-notice",
        to: "retry-ok@example.com",
        templateData: {
          tenantName: SYNTHETIC_TENANTS[0].siteTitle,
          domain: "retry.example.id",
          status: "pending_dns",
        },
      },
    };

    // Attempt 1: E_RATE_LIMITED -> schedules bounded backoff retry
    const attempt1 = buildTrackedBatch([{ id: "m-rl-1", body: envelope, attempts: 1 }]);
    const res1 = await processDurableQueueBatch(attempt1.batch, env, registry, {
      now: () => 1_763_822_000_000,
      baseBackoffSeconds: 5,
      maxBackoffSeconds: 60,
      logger: () => {},
    });
    expect(res1.retried).toBe(1);
    expect(attempt1.outcomes.get("m-rl-1")?.retries).toEqual([{ delaySeconds: 5 }]);
    expect((await getEmailDeliveryClaim(env.PLATFORM_DB, "rate-limit-recover-001"))?.status).toBe(
      "failed",
    );

    // Attempt 2: succeeds -> submitted
    const attempt2 = buildTrackedBatch([{ id: "m-rl-2", body: envelope, attempts: 2 }]);
    const res2 = await processDurableQueueBatch(attempt2.batch, env, registry, {
      now: () => 1_763_822_010_000,
      baseBackoffSeconds: 5,
      maxBackoffSeconds: 60,
      logger: () => {},
    });
    expect(res2.completed).toBe(1);
    expect(transientCalls).toBe(2);
    const finalClaim = await getEmailDeliveryClaim(env.PLATFORM_DB, "rate-limit-recover-001");
    expect(finalClaim?.status).toBe("submitted");
    expect(finalClaim?.attempts).toBe(2);

    // Exhausted retries -> capped & dead-lettered
    const dlqRecords: DeadLetterRecord[] = [];
    const alwaysRateLimited = createCloudflareEmailAdapter({
      async send() {
        throw Object.assign(new Error("E_RATE_LIMITED"), { code: "E_RATE_LIMITED" });
      },
    });
    const cappedRegistry: DurableJobRegistry = {
      [EMAIL_DELIVERY_TOPIC]: createEmailQueueHandler({
        emailPort: alwaysRateLimited,
        maxAttempts: 2,
        now: () => 1_763_822_100_000,
      }),
    };
    const cappedEnvelope = {
      ...envelope,
      idempotencyKey: "rate-limit-dlq-001",
      payload: { ...envelope.payload, messageKey: "rate-limit-dlq-001" },
    };

    const c1 = buildTrackedBatch([{ id: "m-cap-1", body: cappedEnvelope, attempts: 1 }]);
    const r1 = await processDurableQueueBatch(c1.batch, env, cappedRegistry, {
      now: () => 1_763_822_100_000,
      onDeadLetter: (rec) => {
        dlqRecords.push(rec);
      },
      logger: () => {},
    });
    expect(r1.retried).toBe(1);

    const c2 = buildTrackedBatch([{ id: "m-cap-2", body: cappedEnvelope, attempts: 2 }]);
    const r2 = await processDurableQueueBatch(c2.batch, env, cappedRegistry, {
      now: () => 1_763_822_120_000,
      onDeadLetter: (rec) => {
        dlqRecords.push(rec);
      },
      logger: () => {},
    });
    expect(r2.deadLettered).toBe(1);
    expect(dlqRecords).toHaveLength(1);
    expect(dlqRecords[0]?.errorCode).toBe("E_RATE_LIMITED");
    expect((await getJobLedgerRecord(env.PLATFORM_DB, "rate-limit-dlq-001"))?.status).toBe(
      "dead_letter",
    );
  });

  it("NEVER replays a one-shot message on duplicate claim or ambiguous unknown timeout outcome", async () => {
    let providerCalls = 0;
    const timingOutAdapter = createCloudflareEmailAdapter({
      async send() {
        providerCalls += 1;
        const err = new Error("Network socket timed out waiting for SMTP handoff");
        err.name = "TimeoutError";
        throw err;
      },
    });

    const registry: DurableJobRegistry = {
      [EMAIL_DELIVERY_TOPIC]: createEmailQueueHandler({
        emailPort: timingOutAdapter,
        maxAttempts: 3,
        now: () => 1_763_823_000_000,
      }),
    };

    const msgKey = "verify-email:oneshot-timeout-001";
    const batch1 = buildTrackedBatch([
      {
        id: "m-unk-1",
        body: {
          idempotencyKey: msgKey,
          topic: EMAIL_DELIVERY_TOPIC,
          tenantId: null,
          payload: {
            messageKey: msgKey,
            template: "verify-email",
            to: "oneshot@example.com",
            oneShot: true,
            templateData: {
              code: "99887766",
              expiresInMinutes: 10,
            },
          },
        },
      },
    ]);

    const res1 = await processDurableQueueBatch(batch1.batch, env, registry, {
      now: () => 1_763_823_000_000,
      logger: () => {},
    });
    // Ambiguous `unknown` is terminal -> acked, zero retries!
    expect(res1.completed).toBe(1);
    expect(res1.retried).toBe(0);
    expect(providerCalls).toBe(1);

    const claim = await getEmailDeliveryClaim(env.PLATFORM_DB, msgKey);
    expect(claim?.status).toBe("unknown");
    expect(claim?.provider).toBe("cloudflare");
    expect(claim?.errorCode).toBe("TIMEOUT_ERROR");

    // Direct duplicate claim (even with allowRetryOnDefiniteFailure: true) MUST return duplicate and NEVER replay!
    const dupClaim = await claimEmailDelivery(env.PLATFORM_DB, {
      messageKey: msgKey,
      template: "verify-email",
      oneShot: true,
      allowRetryOnDefiniteFailure: true,
      nowMs: 1_763_823_010_000,
    });
    expect(dupClaim.outcome).toBe("duplicate");
    expect(dupClaim.record.status).toBe("unknown");

    // Even if another queue message carries the same messageKey under a different job idempotencyKey,
    // the atomic claim table still blocks replay!
    const batch2 = buildTrackedBatch([
      {
        id: "m-unk-2",
        body: {
          idempotencyKey: "different-job-id-same-msg-key",
          topic: EMAIL_DELIVERY_TOPIC,
          tenantId: null,
          payload: {
            messageKey: msgKey,
            template: "verify-email",
            to: "oneshot@example.com",
            oneShot: true,
            templateData: {
              code: "99887766",
              expiresInMinutes: 10,
            },
          },
        },
      },
    ]);
    await processDurableQueueBatch(batch2.batch, env, registry, {
      now: () => 1_763_823_020_000,
      logger: () => {},
    });
    expect(providerCalls).toBe(1); // Still 1 — never replayed!
  });

  it("verifies signed bounce/complaint webhooks (401 unsigned/invalid/expired, 409 replay, 200 adds suppression)", async () => {
    const secret = "whsec_punyasitus_integration_secret_2026";
    const nowSec = 1_763_824_000;
    const nowMs = nowSec * 1000;
    const bouncedEmail = "hard-bounced@example.com";

    // 1. Unsigned request -> 401
    const unsignedReq = new Request("https://app.punyasitus.com/api/webhooks/email/bounce", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ eventId: "evt-unsigned", type: "hard_bounce", email: bouncedEmail }),
    });
    const unsignedRes = await handleEmailBounceWebhook(unsignedReq, {
      db: env.PLATFORM_DB,
      secret,
      nowMs,
    });
    expect(unsignedRes.status).toBe(401);

    // 2. Invalid signature -> 401
    const rawBody = JSON.stringify({
      eventId: "evt-bounce-001",
      type: "hard_bounce",
      email: bouncedEmail,
      source: "cloudflare",
    });
    const invalidSigReq = new Request("https://app.punyasitus.com/api/webhooks/email/bounce", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Timestamp": String(nowSec),
        "X-Webhook-Signature": `sha256=${"0".repeat(64)}`,
      },
      body: rawBody,
    });
    const invalidSigRes = await handleEmailBounceWebhook(invalidSigReq, {
      db: env.PLATFORM_DB,
      secret,
      nowMs,
    });
    expect(invalidSigRes.status).toBe(401);

    // 3. Stale timestamp (> 5 minutes skew) -> 401
    const staleTs = nowSec - 360;
    const staleSig = await signEmailWebhookPayload({
      secret,
      timestampSeconds: staleTs,
      rawBody,
    });
    const staleReq = new Request("https://app.punyasitus.com/api/webhooks/email/bounce", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Timestamp": String(staleTs),
        "X-Webhook-Signature": staleSig,
      },
      body: rawBody,
    });
    const staleRes = await handleEmailBounceWebhook(staleReq, {
      db: env.PLATFORM_DB,
      secret,
      nowMs,
    });
    expect(staleRes.status).toBe(401);

    // 4. Valid signed hard_bounce -> 200 + adds email hash to email_suppressions
    const validSig = await signEmailWebhookPayload({
      secret,
      timestampSeconds: nowSec,
      rawBody,
    });
    const validReq = new Request("https://app.punyasitus.com/api/webhooks/email/bounce", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Timestamp": String(nowSec),
        "X-Webhook-Signature": validSig,
      },
      body: rawBody,
    });
    const validRes = await handleEmailBounceWebhook(validReq, {
      db: env.PLATFORM_DB,
      secret,
      nowMs,
    });
    expect(validRes.status).toBe(200);
    const validBody = (await validRes.json()) as {
      ok: boolean;
      suppressed: boolean;
      emailHash: string;
      reason: string;
    };
    expect(validBody.ok).toBe(true);
    expect(validBody.suppressed).toBe(true);
    expect(validBody.reason).toBe("hard_bounce");
    expect(validBody.emailHash).toBe(await hashEmailAddress(bouncedEmail));
    expect(await isEmailSuppressed(env.PLATFORM_DB, bouncedEmail)).toBe(true);
    expect(await getSuppressionNoticeForOwner(env.PLATFORM_DB, bouncedEmail)).not.toBeNull();

    // 5. Exact replay of same eventId -> 409 Conflict
    const replayReq = new Request("https://app.punyasitus.com/api/webhooks/email/bounce", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Timestamp": String(nowSec),
        "X-Webhook-Signature": validSig,
      },
      body: rawBody,
    });
    const replayRes = await handleEmailBounceWebhook(replayReq, {
      db: env.PLATFORM_DB,
      secret,
      nowMs: nowMs + 1000,
    });
    expect(replayRes.status).toBe(409);

    // 6. Forged unsigned X-Webhook-Event-Id header CANNOT bypass replay dedup (Finding #2)
    const forgedHeaderReplay = new Request("https://app.punyasitus.com/api/webhooks/email/bounce", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Timestamp": String(nowSec),
        "X-Webhook-Signature": validSig,
        "X-Webhook-Event-Id": "evt_forged_unsigned_header_999",
      },
      body: rawBody,
    });
    const forgedRes = await handleEmailBounceWebhook(forgedHeaderReplay, {
      db: env.PLATFORM_DB,
      secret,
      nowMs: nowMs + 1500,
    });
    expect(forgedRes.status).toBe(409);

    // 7. Transient DB batch failure does NOT poison event_id -> retry succeeds & records suppression (Finding #1)
    const retryEmail = "atomic-retry@example.com";
    const retryBody = JSON.stringify({
      eventId: "evt_atomic_bounce_001",
      type: "hard_bounce",
      email: retryEmail,
      source: "cloudflare",
    });
    const retrySig = await signEmailWebhookPayload({
      secret,
      timestampSeconds: nowSec,
      rawBody: retryBody,
    });
    const failingDb = {
      prepare: env.PLATFORM_DB.prepare.bind(env.PLATFORM_DB),
      async batch() {
        throw new Error("Simulated transient D1 failure during suppression write");
      },
    } as unknown as D1Database;
    await expect(
      handleEmailBounceWebhook(
        new Request("https://app.punyasitus.com/api/webhooks/email/bounce", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Webhook-Timestamp": String(nowSec),
            "X-Webhook-Signature": retrySig,
          },
          body: retryBody,
        }),
        { db: failingDb, secret, nowMs: nowMs + 2000 },
      ),
    ).rejects.toThrow(/Simulated transient D1 failure/);

    // Provider retries with same eventId -> succeeds 200 and records suppression
    const recoveredRes = await handleEmailBounceWebhook(
      new Request("https://app.punyasitus.com/api/webhooks/email/bounce", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Webhook-Timestamp": String(nowSec),
          "X-Webhook-Signature": retrySig,
        },
        body: retryBody,
      }),
      { db: env.PLATFORM_DB, secret, nowMs: nowMs + 3000 },
    );
    expect(recoveredRes.status).toBe(200);
    expect(await isEmailSuppressed(env.PLATFORM_DB, retryEmail)).toBe(true);

    // 8. Salted bounce webhook hash matches queue consumer reading env.EMAIL_SUPPRESSION_SALT (Finding #3)
    const saltedEmail = "salted-bounce@example.com";
    const salt = "prod-suppression-salt-42";
    const saltedBody = JSON.stringify({
      eventId: "evt_salted_bounce_001",
      type: "hard_bounce",
      email: saltedEmail,
      source: "cloudflare",
    });
    const saltedSig = await signEmailWebhookPayload({
      secret,
      timestampSeconds: nowSec,
      rawBody: saltedBody,
    });
    const saltedWebhookRes = await handleEmailBounceWebhook(
      new Request("https://app.punyasitus.com/api/webhooks/email/bounce", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Webhook-Timestamp": String(nowSec),
          "X-Webhook-Signature": saltedSig,
        },
        body: saltedBody,
      }),
      { db: env.PLATFORM_DB, secret, suppressionSalt: salt, nowMs: nowMs + 4000 },
    );
    expect(saltedWebhookRes.status).toBe(200);

    let saltedSendCalls = 0;
    const saltedEnv = {
      ...env,
      EMAIL_SUPPRESSION_SALT: salt,
      EMAIL: {
        async send() {
          saltedSendCalls += 1;
          return { messageId: "should-not-send" };
        },
      },
    };
    const saltedRegistry: DurableJobRegistry = {
      [EMAIL_DELIVERY_TOPIC]: createEmailQueueHandler({ now: () => nowMs + 5000 }),
    };
    const saltedBatch = buildTrackedBatch([
      {
        id: "m-salted-1",
        body: {
          idempotencyKey: "salted-msg-001",
          topic: EMAIL_DELIVERY_TOPIC,
          tenantId: SYNTHETIC_TENANTS[0].id,
          payload: {
            messageKey: "salted-msg-001",
            template: "domain-notice",
            to: saltedEmail,
            templateData: {
              tenantName: SYNTHETIC_TENANTS[0].siteTitle,
              domain: "salted.example.id",
              status: "ssl_active",
            },
          },
        },
      },
    ]);
    await processDurableQueueBatch(
      saltedBatch.batch,
      saltedEnv as unknown as typeof env,
      saltedRegistry,
      { now: () => nowMs + 5000, logger: () => {} },
    );
    expect(saltedSendCalls).toBe(0);
    expect((await getEmailDeliveryClaim(env.PLATFORM_DB, "salted-msg-001"))?.status).toBe(
      "skipped",
    );
  });

  it("captures verification, reset-password, and member-invitation mail in local mail sink for TASK-025/TASK-026 tests", async () => {
    const sink = createLocalMailSink({ now: () => 1_763_825_000_000 });
    const registry: DurableJobRegistry = {
      [EMAIL_DELIVERY_TOPIC]: createEmailQueueHandler({
        emailPort: sink,
        now: () => 1_763_825_000_000,
      }),
    };

    const { batch } = buildTrackedBatch([
      {
        id: "m-sink-1",
        body: {
          idempotencyKey: "auth:verify:u1",
          topic: EMAIL_DELIVERY_TOPIC,
          tenantId: null,
          payload: {
            messageKey: "auth:verify:u1",
            template: "verify-email",
            to: "newuser@example.com",
            templateData: {
              recipientName: "Rina",
              code: "11223344",
              verifyUrl: "https://app.punyasitus.com/auth/verify?c=1",
            },
          },
        },
      },
      {
        id: "m-sink-2",
        body: {
          idempotencyKey: "auth:reset:u1",
          topic: EMAIL_DELIVERY_TOPIC,
          tenantId: null,
          payload: {
            messageKey: "auth:reset:u1",
            template: "reset-password",
            to: "newuser@example.com",
            templateData: {
              recipientName: "Rina",
              resetUrl: "https://app.punyasitus.com/auth/reset?t=xyz",
            },
          },
        },
      },
      {
        id: "m-sink-3",
        body: {
          idempotencyKey: "org:invite:inv1",
          topic: EMAIL_DELIVERY_TOPIC,
          tenantId: SYNTHETIC_TENANTS[1].id,
          payload: {
            messageKey: "org:invite:inv1",
            template: "member-invitation",
            to: "staff@example.com",
            templateData: {
              inviterName: "Dr. Andi",
              organizationName: SYNTHETIC_TENANTS[1].siteTitle,
              roleLabel: "Admin",
              acceptUrl: "https://app.punyasitus.com/invite/inv1",
            },
          },
        },
      },
    ]);

    const res = await processDurableQueueBatch(batch, env, registry, {
      now: () => 1_763_825_000_000,
      logger: () => {},
    });

    expect(res.completed).toBe(3);
    expect(sink.list()).toHaveLength(3);
    expect(sink.findByTemplate("verify-email")[0]?.text).toContain("11223344");
    expect(sink.findByTemplate("verify-email")[0]?.subject).not.toContain("11223344");
    expect(sink.findByTemplate("reset-password")[0]?.text).toContain(
      "https://app.punyasitus.com/auth/reset?t=xyz",
    );
    expect(sink.findByTemplate("member-invitation")[0]?.text).toContain("Dr. Andi");
    expect(sink.findByTemplate("member-invitation")[0]?.from).toBe(ALLOWED_EMAIL_SENDER);
  });
});

import { env } from "cloudflare:workers";
import {
  applySessionTwoFactorMigration,
  createAuth,
  createTwoFactorEnrolledOperatorFixture,
  DEFAULT_SECOND_FACTOR_WINDOW_MS,
} from "@punyasitus/auth";
import {
  DAY_MS,
  DEFAULT_MONTHLY_PRICE_IDR,
  TRIAL_DURATION_MS,
  createMockOnlyVerifiedSettlementPolicy,
} from "@punyasitus/core/billing/index";
import {
  RECEIPT_NON_PKP_NOTICE,
  computeSha256Hex,
  generateReceiptPdf,
  inspectReceiptPdf,
} from "@punyasitus/core/billing/receipt-pdf";
import { createLocalMailSink, type EmailPort } from "@punyasitus/core/email/index";
import {
  beginDurablePaymentAttempt,
  completePaymentAttemptPending,
  ensureBillingReconciliationSchema,
  settleVerifiedPaymentAttempt,
} from "@punyasitus/db/billing/index";
import {
  allocateAndInsertPaymentReceipt,
  applyBillingReceiptsMigration,
  findPaymentReceiptById,
  findPaymentReceiptBySettlementId,
  markPaymentReceiptEmailed,
} from "@punyasitus/db/billing/receipts/index";
import { applyPlatformMigrations, createSqliteDrizzle } from "@punyasitus/db/connections";
import {
  agencies,
  ensurePlatformOperatorRolesSchema,
  listPlatformAuditEntries,
  members,
  organizations,
  PLATFORM_MIGRATIONS,
  platformSchema,
  tenants,
} from "@punyasitus/db/platform";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AgencyReceiptRuntimeEnv } from "../../apps/web/src/pages/api/agency/receipts/_shared.ts";
import { handleAgencyReceiptPdfRequest } from "../../apps/web/src/pages/api/agency/receipts/[receiptId]/pdf.ts";
import { handleAgencyReceiptsListRequest } from "../../apps/web/src/pages/api/agency/receipts/index.ts";
import type { ConsoleBillingRuntimeEnv } from "../../apps/web/src/pages/api/console/billing/_shared.ts";
import { handleConsoleBillingReceiptPdfRequest } from "../../apps/web/src/pages/api/console/billing/receipts/[receiptId]/pdf.ts";
import { handleConsoleBillingRefundRequest } from "../../apps/web/src/pages/api/console/billing/refund.ts";
import type { TenantReceiptRuntimeEnv } from "../../apps/web/src/pages/api/tenants/[tenantId]/billing/receipts/_shared.ts";
import { handleTenantBillingReceiptPdfRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/billing/receipts/[receiptId]/pdf.ts";
import { handleTenantBillingReceiptsListRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/billing/receipts/index.ts";
import {
  BILLING_RECEIPT_DELIVERY_TOPIC,
  ReceiptDeliveryRetryableError,
  createBillingJobRegistry,
  issueAndDeliverRefundCreditNote,
  issueAndDeliverSettlementReceipt,
  reconcilePaymentAttemptViaAdvice,
  storeReceiptPdfImmutably,
} from "../../apps/web/src/worker/queues/billing/index.ts";
import type { AutoLarisBillingClient } from "../../packages/integrations/src/autolaris/index.ts";

const APP_ORIGIN = "https://app.punyasitus.com";
const CONSOLE_ORIGIN = "https://console.punyasitus.com";
const TENANT_ORIGIN = "https://toko-t081.situsku.click";
const TEST_APP_SECRET = "task081-app-auth-secret-0123456789abcdef0123456789abcdef";
const TEST_CONSOLE_SECRET = "task081-console-auth-secret-fedcba9876543210fedcba987654";
const BASE_NOW_MS = Date.UTC(2026, 0, 31, 10, 0, 0); // 2026-01-31T17:00:00+07:00 (WIB)
const MOCK_POLICY = createMockOnlyVerifiedSettlementPolicy();

function buildAppEnv(extra?: Partial<TenantReceiptRuntimeEnv>): TenantReceiptRuntimeEnv {
  return {
    APP_ENV: "test",
    PLATFORM_DOMAIN: "punyasitus.com",
    PLATFORM_DB: env.PLATFORM_DB,
    MEDIA_BUCKET: env.MEDIA_BUCKET,
    AUTH_SECRET: TEST_APP_SECRET,
    CONSOLE_AUTH_SECRET: TEST_CONSOLE_SECRET,
    ...extra,
  };
}

function buildAgencyEnv(extra?: Partial<AgencyReceiptRuntimeEnv>): AgencyReceiptRuntimeEnv {
  return {
    APP_ENV: "test",
    PLATFORM_DOMAIN: "punyasitus.com",
    PLATFORM_DB: env.PLATFORM_DB,
    MEDIA_BUCKET: env.MEDIA_BUCKET,
    AUTH_SECRET: TEST_APP_SECRET,
    CONSOLE_AUTH_SECRET: TEST_CONSOLE_SECRET,
    ...extra,
  };
}

function buildConsoleEnv(extra?: Partial<ConsoleBillingRuntimeEnv>): ConsoleBillingRuntimeEnv {
  return {
    APP_ENV: "test",
    PLATFORM_DOMAIN: "punyasitus.com",
    PLATFORM_DB: env.PLATFORM_DB,
    MEDIA_BUCKET: env.MEDIA_BUCKET,
    AUTH_SECRET: TEST_APP_SECRET,
    CONSOLE_AUTH_SECRET: TEST_CONSOLE_SECRET,
    ...extra,
  };
}

function createConsoleAuth() {
  return createAuth(env.PLATFORM_DB, {
    baseURL: CONSOLE_ORIGIN,
    secret: TEST_CONSOLE_SECRET,
    surface: "console",
    trustedOrigins: [CONSOLE_ORIGIN],
  });
}

async function clearReceiptBucketPrefix(): Promise<void> {
  const listed = await env.MEDIA_BUCKET.list({ prefix: "platform/receipts/" });
  for (const obj of listed.objects) {
    await env.MEDIA_BUCKET.delete(obj.key);
  }
}

async function resetTables(): Promise<void> {
  await env.PLATFORM_DB.prepare("DROP TRIGGER IF EXISTS payment_receipts_no_delete").run();
  await env.PLATFORM_DB.batch([
    env.PLATFORM_DB.prepare("DELETE FROM job_ledger"),
    env.PLATFORM_DB.prepare("DELETE FROM payment_receipts"),
    env.PLATFORM_DB.prepare("DELETE FROM receipt_yearly_counters"),
    env.PLATFORM_DB.prepare("DELETE FROM billing_refund_records"),
    env.PLATFORM_DB.prepare("DELETE FROM billing_reconciliation_leases"),
    env.PLATFORM_DB.prepare("DELETE FROM entitlement_grants"),
    env.PLATFORM_DB.prepare("DELETE FROM settlements"),
    env.PLATFORM_DB.prepare("DELETE FROM payment_attempts"),
    env.PLATFORM_DB.prepare("DELETE FROM billing_obligations"),
    env.PLATFORM_DB.prepare("DELETE FROM session_two_factor_verifications"),
    env.PLATFORM_DB.prepare("DELETE FROM two_factors"),
    env.PLATFORM_DB.prepare("DELETE FROM platform_operators"),
    env.PLATFORM_DB.prepare("DELETE FROM platform_settings"),
    env.PLATFORM_DB.prepare("DELETE FROM tenants"),
    env.PLATFORM_DB.prepare("DELETE FROM agencies"),
    env.PLATFORM_DB.prepare("DELETE FROM members"),
    env.PLATFORM_DB.prepare("DELETE FROM organizations"),
    env.PLATFORM_DB.prepare("DELETE FROM accounts"),
    env.PLATFORM_DB.prepare("DELETE FROM sessions"),
    env.PLATFORM_DB.prepare("DELETE FROM verifications"),
    env.PLATFORM_DB.prepare("DELETE FROM users"),
  ]);
  // Re-create the immutability delete trigger immediately after test table reset
  await env.PLATFORM_DB.prepare(
    `CREATE TRIGGER IF NOT EXISTS payment_receipts_no_delete
     BEFORE DELETE ON payment_receipts
     BEGIN
       SELECT RAISE(ABORT, 'payment_receipts is immutable and cannot be deleted');
     END`,
  ).run();
  await clearReceiptBucketPrefix();
}

let seq = 0;
function nextSeq(): number {
  seq += 1;
  return seq;
}

async function seedSettledTenant(options: {
  readonly agencyId?: string | null;
  readonly agencyOrgId?: string | null;
  readonly agencyStaffUserId?: string | null;
  readonly channelKind?: "QRIS" | "VA";
  readonly channelFeeIdr?: number;
  readonly nowMs?: number;
  readonly includeAdminAndEditor?: boolean;
} = {}): Promise<{
  readonly tenantId: string;
  readonly orgId: string;
  readonly handle: string;
  readonly ownerUserId: string;
  readonly adminUserId: string | null;
  readonly editorUserId: string | null;
  readonly obligationId: string;
  readonly attemptId: string;
  readonly settlementId: string;
  readonly totalPayableIdr: number;
}> {
  const n = nextSeq();
  const nowMs = options.nowMs ?? BASE_NOW_MS;
  const db = createSqliteDrizzle(env.PLATFORM_DB, platformSchema);
  const orgId = `org_t081_${n}`;
  const tenantId = `ten_t081_${n}`;
  const handle = `situs-t081-${n}`;
  const ownerUserId = `usr_owner_t081_${n}`;

  await env.PLATFORM_DB.prepare(
    `INSERT INTO users (id, name, email, email_verified, created_at, updated_at)
     VALUES (?, ?, ?, 1, ?, ?)`,
  )
    .bind(ownerUserId, `Pemilik ${n}`, `owner${n}@example.com`, nowMs, nowMs)
    .run();

  await db.insert(organizations).values({
    id: orgId,
    name: `Bisnis T081 ${n}`,
    slug: handle,
    createdAt: new Date(nowMs),
    updatedAt: new Date(nowMs),
  });

  await db.insert(members).values({
    id: `mem_owner_t081_${n}`,
    organizationId: orgId,
    userId: ownerUserId,
    role: "owner",
    createdAt: new Date(nowMs),
  });

  let adminUserId: string | null = null;
  let editorUserId: string | null = null;
  if (options.includeAdminAndEditor) {
    adminUserId = `usr_admin_t081_${n}`;
    editorUserId = `usr_editor_t081_${n}`;
    await env.PLATFORM_DB.batch([
      env.PLATFORM_DB.prepare(
        `INSERT INTO users (id, name, email, email_verified, created_at, updated_at)
         VALUES (?, ?, ?, 1, ?, ?)`,
      ).bind(adminUserId, `Admin ${n}`, `admin${n}@example.com`, nowMs, nowMs),
      env.PLATFORM_DB.prepare(
        `INSERT INTO users (id, name, email, email_verified, created_at, updated_at)
         VALUES (?, ?, ?, 1, ?, ?)`,
      ).bind(editorUserId, `Editor ${n}`, `editor${n}@example.com`, nowMs, nowMs),
      env.PLATFORM_DB.prepare(
        `INSERT INTO members (id, organization_id, user_id, role, created_at)
         VALUES (?, ?, ?, 'admin', ?)`,
      ).bind(`mem_admin_t081_${n}`, orgId, adminUserId, nowMs),
      env.PLATFORM_DB.prepare(
        `INSERT INTO members (id, organization_id, user_id, role, created_at)
         VALUES (?, ?, ?, 'editor', ?)`,
      ).bind(`mem_editor_t081_${n}`, orgId, editorUserId, nowMs),
    ]);
  }

  if (options.agencyStaffUserId) {
    await db.insert(members).values({
      id: `mem_agstaff_t081_${n}`,
      organizationId: orgId,
      userId: options.agencyStaffUserId,
      role: "agency_staff",
      createdAt: new Date(nowMs),
    });
  }

  const trialEndsAtMs = nowMs + TRIAL_DURATION_MS;
  await db.insert(tenants).values({
    id: tenantId,
    organizationId: orgId,
    agencyId: options.agencyId ?? null,
    handle,
    name: `Bisnis T081 ${n}`,
    vertical: "compro",
    status: "trial",
    operatorHold: false,
    trialEndsAt: new Date(trialEndsAtMs),
    paidThrough: null,
    deletionDueAt: new Date(trialEndsAtMs + 30 * DAY_MS),
    createdAt: new Date(nowMs),
    updatedAt: new Date(nowMs),
  });

  const channelKind = options.channelKind ?? "VA";
  const channelCode = channelKind === "QRIS" ? "QRIS" : "VAMANDIRI";
  const channelFeeIdr = options.channelFeeIdr ?? (channelKind === "QRIS" ? 1_253 : 3_000);
  const totalPayableIdr = DEFAULT_MONTHLY_PRICE_IDR + channelFeeIdr;
  const providerTrxId = `AL-TRX-T081-${n}`;

  const begun = await beginDurablePaymentAttempt(env.PLATFORM_DB, {
    tenantId,
    effectiveTenantStatus: "trial",
    payerType: options.agencyId ? "agency" : "tenant",
    payerAgencyId: options.agencyId ?? null,
    plan: "monthly",
    channelKind,
    channelCode,
    estimatedChannelFeeIdr: channelFeeIdr,
    idempotencyKey: crypto.randomUUID(),
    requestHash: `hash_t081_${n}`,
    providerAccountId: "acct-t081",
    nowMs,
  });

  await completePaymentAttemptPending(env.PLATFORM_DB, {
    attemptId: begun.attempt.id,
    obligationId: begun.obligation.id,
    tenantId,
    providerTransactionId: providerTrxId,
    channelFeeIdr,
    totalPayableIdr,
    grossAdminFeeIdr: channelFeeIdr,
    providerDiscountIdr: 0,
    qrisPayload: channelKind === "QRIS" ? "000201010212SECRETQRIS" : null,
    vaNumber: channelKind === "VA" ? "88001234567890" : null,
    bankName: channelKind === "VA" ? "Bank Mandiri" : null,
    paymentRedirectUrl: null,
    expiresAtMs: nowMs + 86_400_000,
    actorUserId: ownerUserId,
    actorRole: "owner",
    requestId: `req_seed_${n}`,
    nowMs,
  });

  const settled = await settleVerifiedPaymentAttempt(env.PLATFORM_DB, {
    attemptId: begun.attempt.id,
    obligationId: begun.obligation.id,
    tenantId,
    plan: "monthly",
    verifiedAmountIdr: totalPayableIdr,
    providerTransactionId: providerTrxId,
    providerStatus: "SETTLED_MOCK_VERIFIED",
    policyProfile: MOCK_POLICY.profile,
    policyVersion: MOCK_POLICY.policyVersion,
    settledAtMs: nowMs,
    reconciledVia: "advice",
    actorUserId: null,
    actorRole: "system",
    requestId: `req_settle_${n}`,
    nowMs,
  });

  if (settled.outcome !== "settled") {
    throw new Error(`Expected settled outcome in seed, got ${settled.outcome}`);
  }

  return {
    tenantId,
    orgId,
    handle,
    ownerUserId,
    adminUserId,
    editorUserId,
    obligationId: begun.obligation.id,
    attemptId: begun.attempt.id,
    settlementId: settled.settlementId,
    totalPayableIdr,
  };
}

async function seedAgency(label: string, nowMs = BASE_NOW_MS): Promise<{
  readonly agencyId: string;
  readonly agencyOrgId: string;
  readonly agencyOwnerUserId: string;
  readonly agencyStaffUserId: string;
}> {
  const n = nextSeq();
  const db = createSqliteDrizzle(env.PLATFORM_DB, platformSchema);
  const agencyId = `agn_t081_${label}_${n}`;
  const agencyOrgId = `org_agn_t081_${label}_${n}`;
  const agencyOwnerUserId = `usr_agn_owner_${label}_${n}`;
  const agencyStaffUserId = `usr_agn_staff_${label}_${n}`;

  await env.PLATFORM_DB.batch([
    env.PLATFORM_DB.prepare(
      `INSERT INTO users (id, name, email, email_verified, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?)`,
    ).bind(
      agencyOwnerUserId,
      `Owner Agensi ${label}`,
      `agency-owner-${label}-${n}@example.com`,
      nowMs,
      nowMs,
    ),
    env.PLATFORM_DB.prepare(
      `INSERT INTO users (id, name, email, email_verified, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?)`,
    ).bind(
      agencyStaffUserId,
      `Staf Agensi ${label}`,
      `agency-staff-${label}-${n}@example.com`,
      nowMs,
      nowMs,
    ),
  ]);

  await db.insert(organizations).values({
    id: agencyOrgId,
    name: `Agensi ${label}`,
    slug: `agensi-${label}-${n}`,
    createdAt: new Date(nowMs),
    updatedAt: new Date(nowMs),
  });

  await db.insert(members).values([
    {
      id: `mem_ag_own_${n}`,
      organizationId: agencyOrgId,
      userId: agencyOwnerUserId,
      role: "owner",
      createdAt: new Date(nowMs),
    },
    {
      id: `mem_ag_stf_${n}`,
      organizationId: agencyOrgId,
      userId: agencyStaffUserId,
      role: "agency_staff",
      createdAt: new Date(nowMs),
    },
  ]);

  await db.insert(agencies).values({
    id: agencyId,
    organizationId: agencyOrgId,
    ownerUserId: agencyOwnerUserId,
    name: `PT Agensi ${label}`,
    status: "active",
    discountPercent: 10,
    unpaidTrialCap: 3,
    createdAt: new Date(nowMs),
    updatedAt: new Date(nowMs),
  });

  return { agencyId, agencyOrgId, agencyOwnerUserId, agencyStaffUserId };
}

function decodeBase64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

describe("TASK-081 workerd integration: numbered receipts, immutability, R2 + EmailPort, credit notes & authz", () => {
  beforeAll(async () => {
    await applyPlatformMigrations(env.PLATFORM_DB, PLATFORM_MIGRATIONS);
    await applySessionTwoFactorMigration(env.PLATFORM_DB);
    await ensurePlatformOperatorRolesSchema(env.PLATFORM_DB);
    await ensureBillingReconciliationSchema(env.PLATFORM_DB);
    await applyBillingReceiptsMigration(env.PLATFORM_DB);
  });

  beforeEach(async () => {
    await resetTables();
  });

  it("allocates gap-free yearly sequential receipt numbers under concurrent Promise.all settlements, is idempotent on replay, stores immutable PDFs in R2, and emails 1 receipt per settlement", async () => {
    const mailSink = createLocalMailSink();
    const seeded = [];
    for (let i = 0; i < 6; i += 1) {
      seeded.push(
        await seedSettledTenant({
          channelKind: i % 2 === 0 ? "VA" : "QRIS",
          nowMs: BASE_NOW_MS + i * 1_000,
        }),
      );
    }

    // Fire all 6 settlements concurrently via Promise.all
    const results = await Promise.all(
      seeded.map((item) =>
        issueAndDeliverSettlementReceipt({
          db: env.PLATFORM_DB,
          mediaBucket: env.MEDIA_BUCKET,
          settlementId: item.settlementId,
          emailPort: mailSink,
          nowMs: BASE_NOW_MS + 10_000,
        }),
      ),
    );

    const receiptNumbers = results.map((r) => r.receipt.receiptNumber).sort();
    expect(receiptNumbers).toEqual([
      "PS-2026-000001",
      "PS-2026-000002",
      "PS-2026-000003",
      "PS-2026-000004",
      "PS-2026-000005",
      "PS-2026-000006",
    ]);

    for (const res of results) {
      expect(res.created).toBe(true);
      expect(res.r2Stored).toBe(true);
      expect(res.emailOutcome).toBe("submitted");
      expect(res.receipt.emailedAtMs).not.toBeNull();
      expect(res.receipt.nonPkpNotice).toBe(RECEIPT_NON_PKP_NOTICE);

      // Verify immutable PDF in R2 matches DB SHA-256 and parses with pdf-lib
      const r2Obj = await env.MEDIA_BUCKET.get(res.receipt.r2ObjectKey);
      expect(r2Obj).not.toBeNull();
      const r2Bytes = new Uint8Array(await r2Obj!.arrayBuffer());
      expect(r2Bytes.byteLength).toBe(res.receipt.pdfByteLength);
      expect(await computeSha256Hex(r2Bytes)).toBe(res.receipt.pdfSha256);
      const pdfDoc = await inspectReceiptPdf(r2Bytes);
      expect(pdfDoc.pageCount).toBe(1);
    }

    // Verify counter has zero gaps
    const counter = await env.PLATFORM_DB.prepare(
      "SELECT last_seq FROM receipt_yearly_counters WHERE year = 2026",
    ).first<{ readonly last_seq: number }>();
    expect(counter?.last_seq).toBe(6);

    // Verify EmailPort received exactly 1 email per settlement with valid Base64 PDF attachment
    expect(mailSink.list()).toHaveLength(6);
    for (const mail of mailSink.list()) {
      expect(mail.attachments).toHaveLength(1);
      const att = mail.attachments[0]!;
      expect(att.contentType).toBe("application/pdf");
      expect(att.filename).toMatch(/^PS-2026-00000[1-6]\.pdf$/);
      const decodedBytes = decodeBase64ToBytes(att.content);
      expect(new TextDecoder("ascii").decode(decodedBytes.slice(0, 7))).toMatch(/^%PDF-1\./);
    }

    // Re-run concurrently 3x for the SAME settlementId -> 100% idempotent, zero counter bump, zero duplicate email!
    const target = seeded[0]!;
    const firstReceipt = results[0]!.receipt;
    const replays = await Promise.all([
      issueAndDeliverSettlementReceipt({
        db: env.PLATFORM_DB,
        mediaBucket: env.MEDIA_BUCKET,
        settlementId: target.settlementId,
        emailPort: mailSink,
        nowMs: BASE_NOW_MS + 20_000,
      }),
      issueAndDeliverSettlementReceipt({
        db: env.PLATFORM_DB,
        mediaBucket: env.MEDIA_BUCKET,
        settlementId: target.settlementId,
        emailPort: mailSink,
        nowMs: BASE_NOW_MS + 20_000,
      }),
      issueAndDeliverSettlementReceipt({
        db: env.PLATFORM_DB,
        mediaBucket: env.MEDIA_BUCKET,
        settlementId: target.settlementId,
        emailPort: mailSink,
        nowMs: BASE_NOW_MS + 20_000,
      }),
    ]);

    for (const replay of replays) {
      expect(replay.created).toBe(false);
      expect(replay.receipt.id).toBe(firstReceipt.id);
      expect(replay.receipt.receiptNumber).toBe(firstReceipt.receiptNumber);
      expect(replay.r2Stored).toBe(false);
      expect(replay.emailOutcome).toBe("already_emailed");
    }

    const counterAfterReplay = await env.PLATFORM_DB.prepare(
      "SELECT last_seq FROM receipt_yearly_counters WHERE year = 2026",
    ).first<{ readonly last_seq: number }>();
    expect(counterAfterReplay?.last_seq).toBe(6);
    expect(mailSink.list()).toHaveLength(6);

    // Tampered R2 overwrite attempt fails closed with integrity error
    await expect(
      storeReceiptPdfImmutably(env.MEDIA_BUCKET, {
        objectKey: firstReceipt.r2ObjectKey,
        receiptNumber: firstReceipt.receiptNumber,
        documentKind: "receipt",
        pdfBytes: new TextEncoder().encode("%PDF-1.7 tampered"),
        expectedSha256Hex: "0".repeat(64),
      }),
    ).rejects.toThrow(/integritas/i);
  });

  it("enforces SQLite immutability triggers blocking UPDATE of issued receipt fields and DELETE, while allowing emailed_at NULL -> timestamp once", async () => {
    const seeded = await seedSettledTenant();
    // Issue WITHOUT emailPort so emailed_at starts as NULL
    const issued = await issueAndDeliverSettlementReceipt({
      db: env.PLATFORM_DB,
      mediaBucket: env.MEDIA_BUCKET,
      settlementId: seeded.settlementId,
      emailPort: null,
      nowMs: BASE_NOW_MS,
    });
    expect(issued.receipt.emailedAtMs).toBeNull();

    // Mutating amounts, receipt_number, r2_object_key, pdf_sha256, non_pkp_notice MUST fail
    await expect(
      env.PLATFORM_DB.prepare("UPDATE payment_receipts SET total_amount_idr = 1 WHERE id = ?")
        .bind(issued.receipt.id)
        .run(),
    ).rejects.toThrow(/immutable/i);

    await expect(
      env.PLATFORM_DB.prepare(
        "UPDATE payment_receipts SET receipt_number = 'PS-2026-999999' WHERE id = ?",
      )
        .bind(issued.receipt.id)
        .run(),
    ).rejects.toThrow(/immutable/i);

    await expect(
      env.PLATFORM_DB.prepare(
        "UPDATE payment_receipts SET r2_object_key = 'platform/receipts/2026/hacked.pdf' WHERE id = ?",
      )
        .bind(issued.receipt.id)
        .run(),
    ).rejects.toThrow(/immutable/i);

    await expect(
      env.PLATFORM_DB.prepare("UPDATE payment_receipts SET pdf_sha256 = 'deadbeef' WHERE id = ?")
        .bind(issued.receipt.id)
        .run(),
    ).rejects.toThrow(/immutable/i);

    await expect(
      env.PLATFORM_DB.prepare(
        "UPDATE payment_receipts SET non_pkp_notice = 'Termasuk PPN 11%' WHERE id = ?",
      )
        .bind(issued.receipt.id)
        .run(),
    ).rejects.toThrow(/immutable/i);

    // DELETE MUST fail
    await expect(
      env.PLATFORM_DB.prepare("DELETE FROM payment_receipts WHERE id = ?")
        .bind(issued.receipt.id)
        .run(),
    ).rejects.toThrow(/immutable|deleted/i);

    // Single transition of emailed_at from NULL -> timestamp IS allowed
    const updatedOnce = await markPaymentReceiptEmailed(
      env.PLATFORM_DB,
      issued.receipt.id,
      BASE_NOW_MS + 5_000,
    );
    expect(updatedOnce).toBe(true);

    // Second update of emailed_at (already non-null) MUST be rejected by trigger
    await expect(
      env.PLATFORM_DB.prepare("UPDATE payment_receipts SET emailed_at = ? WHERE id = ?")
        .bind(BASE_NOW_MS + 9_000, issued.receipt.id)
        .run(),
    ).rejects.toThrow(/immutable/i);
  });

  it("issues a linked credit note on duplicate-payment refund via console endpoint WITHOUT altering original receipt or R2 PDF", async () => {
    const mailSink = createLocalMailSink();
    const seeded = await seedSettledTenant({ channelKind: "VA", channelFeeIdr: 3_000 });
    const issued = await issueAndDeliverSettlementReceipt({
      db: env.PLATFORM_DB,
      mediaBucket: env.MEDIA_BUCKET,
      settlementId: seeded.settlementId,
      emailPort: mailSink,
      nowMs: BASE_NOW_MS,
    });
    const originalReceipt = issued.receipt;
    expect(originalReceipt.receiptNumber).toBe("PS-2026-000001");

    const originalR2Before = new Uint8Array(
      await (await env.MEDIA_BUCKET.get(originalReceipt.r2ObjectKey))!.arrayBuffer(),
    );
    const originalShaBefore = await computeSha256Hex(originalR2Before);

    // Create active 2FA console operator with fresh step-up
    const consoleAuth = createConsoleAuth();
    const operator = await createTwoFactorEnrolledOperatorFixture(env.PLATFORM_DB, {
      auth: consoleAuth,
      email: "superadmin-t081@punyasitus.com",
      name: "Superadmin T081",
      password: "OperatorPassword!2026",
      nowMs: BASE_NOW_MS,
    });

    const refundReq = new Request(`${CONSOLE_ORIGIN}/api/console/billing/refund`, {
      method: "POST",
      headers: {
        Cookie: operator.cookieHeader,
        Origin: CONSOLE_ORIGIN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        obligationId: seeded.obligationId,
        paymentAttemptId: seeded.attemptId,
        tenantId: seeded.tenantId,
        refundKind: "duplicate_payment",
        amountIdr: seeded.totalPayableIdr,
        externalReference: "TRF-BCA-DUP-20260131",
        reason: "Pembayaran ganda terverifikasi melalui mutasi bank manual",
      }),
    });

    const refundRes = await handleConsoleBillingRefundRequest(refundReq, buildConsoleEnv(), {
      nowMs: BASE_NOW_MS + 60_000,
      emailPort: mailSink,
    });

    expect(refundRes.status).toBe(201);
    const body = (await refundRes.json()) as {
      readonly success: boolean;
      readonly refund: { readonly id: string; readonly settlementId: string | null };
      readonly creditNote?: {
        readonly id: string;
        readonly receiptNumber: string;
        readonly documentKind: string;
        readonly linkedReceiptId: string | null;
        readonly linkedReceiptNumber: string | null;
        readonly r2ObjectKey: string;
        readonly pdfSha256: string;
        readonly emailOutcome: string;
      };
    };

    expect(body.success).toBe(true);
    expect(body.creditNote).toBeDefined();
    expect(body.creditNote!.documentKind).toBe("credit_note");
    expect(body.creditNote!.receiptNumber).toBe("PS-2026-000002");
    expect(body.creditNote!.linkedReceiptId).toBe(originalReceipt.id);
    expect(body.creditNote!.linkedReceiptNumber).toBe("PS-2026-000001");
    expect(body.creditNote!.emailOutcome).toBe("submitted");

    // Verify original receipt row and R2 bytes are 100% UNCHANGED
    const originalAfter = await findPaymentReceiptById(env.PLATFORM_DB, originalReceipt.id);
    expect(originalAfter).toEqual(originalReceipt);

    const originalR2After = new Uint8Array(
      await (await env.MEDIA_BUCKET.get(originalReceipt.r2ObjectKey))!.arrayBuffer(),
    );
    expect(originalR2After).toEqual(originalR2Before);
    expect(await computeSha256Hex(originalR2After)).toBe(originalShaBefore);

    // Verify credit note PDF exists in R2, is distinct, and parses cleanly
    const cnR2 = await env.MEDIA_BUCKET.get(body.creditNote!.r2ObjectKey);
    expect(cnR2).not.toBeNull();
    const cnBytes = new Uint8Array(await cnR2!.arrayBuffer());
    expect(await computeSha256Hex(cnBytes)).toBe(body.creditNote!.pdfSha256);
    expect(body.creditNote!.pdfSha256).not.toBe(originalReceipt.pdfSha256);
    const parsedCn = await inspectReceiptPdf(cnBytes);
    expect(parsedCn.title).toContain("NOTA KREDIT PENGEMBALIAN DANA");
    expect(parsedCn.subject).toContain("PS-2026-000001");

    // Verify idempotent re-invocation of credit note delivery does NOT bump counter or re-email
    const cnReplay = await issueAndDeliverRefundCreditNote({
      db: env.PLATFORM_DB,
      mediaBucket: env.MEDIA_BUCKET,
      refundId: body.refund.id,
      emailPort: mailSink,
      nowMs: BASE_NOW_MS + 120_000,
    });
    expect(cnReplay.created).toBe(false);
    expect(cnReplay.receipt.id).toBe(body.creditNote!.id);
    expect(cnReplay.emailOutcome).toBe("already_emailed");
    expect(mailSink.list()).toHaveLength(2); // 1 receipt + 1 credit note
  });

  it("automatically issues & delivers a numbered receipt when Advice reconciliation confirms settlement", async () => {
    const mailSink = createLocalMailSink();
    const db = createSqliteDrizzle(env.PLATFORM_DB, platformSchema);
    const n = nextSeq();
    const orgId = `org_adv_${n}`;
    const tenantId = `ten_adv_${n}`;
    const handle = `adv-t081-${n}`;
    const ownerId = `usr_adv_${n}`;

    await env.PLATFORM_DB.prepare(
      `INSERT INTO users (id, name, email, email_verified, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?)`,
    )
      .bind(ownerId, "Pemilik Advice", "advice-owner@example.com", BASE_NOW_MS, BASE_NOW_MS)
      .run();

    await db.insert(organizations).values({
      id: orgId,
      name: "Toko Advice",
      slug: handle,
      createdAt: new Date(BASE_NOW_MS),
      updatedAt: new Date(BASE_NOW_MS),
    });
    await db.insert(members).values({
      id: `mem_adv_${n}`,
      organizationId: orgId,
      userId: ownerId,
      role: "owner",
      createdAt: new Date(BASE_NOW_MS),
    });
    await db.insert(tenants).values({
      id: tenantId,
      organizationId: orgId,
      handle,
      name: "Toko Advice",
      vertical: "compro",
      status: "trial",
      trialEndsAt: new Date(BASE_NOW_MS + TRIAL_DURATION_MS),
      createdAt: new Date(BASE_NOW_MS),
      updatedAt: new Date(BASE_NOW_MS),
    });

    const begun = await beginDurablePaymentAttempt(env.PLATFORM_DB, {
      tenantId,
      effectiveTenantStatus: "trial",
      payerType: "tenant",
      payerAgencyId: null,
      plan: "monthly",
      channelKind: "QRIS",
      channelCode: "QRIS",
      estimatedChannelFeeIdr: 1_253,
      idempotencyKey: crypto.randomUUID(),
      requestHash: "hash_adv_receipt",
      providerAccountId: "acct-adv",
      nowMs: BASE_NOW_MS,
    });

    const totalPayableIdr = DEFAULT_MONTHLY_PRICE_IDR + 1_253;
    await completePaymentAttemptPending(env.PLATFORM_DB, {
      attemptId: begun.attempt.id,
      obligationId: begun.obligation.id,
      tenantId,
      providerTransactionId: "AL-TRX-ADV-081",
      channelFeeIdr: 1_253,
      totalPayableIdr,
      grossAdminFeeIdr: 1_253,
      providerDiscountIdr: 0,
      qrisPayload: "000201010212MOCKQRIS",
      vaNumber: null,
      bankName: null,
      paymentRedirectUrl: null,
      expiresAtMs: BASE_NOW_MS + 86_400_000,
      actorUserId: ownerId,
      actorRole: "owner",
      requestId: "req_adv_pending",
      nowMs: BASE_NOW_MS,
    });

    const mockClient: AutoLarisBillingClient = {
      providerAccountId: "acct-adv",
      relayOrigin: "https://autolaris-relay.punyasitus.com",
      listPaymentChannels: async () => [],
      submitDigitalSubscriptionOrder: async () => {
        throw new Error("not used");
      },
      checkTransactionAdvice: async () => ({
        rc: "00",
        ket: "OK",
        providerTransactionId: "AL-TRX-ADV-081",
        reffId: begun.attempt.reffId,
        paymentStatus: "PAID_SETTLED",
        shippingStatus: null,
        paidAmountIdr: totalPayableIdr,
        currency: "IDR",
        settledAtMs: BASE_NOW_MS + 5_000,
      }),
    };

    const outcome = await reconcilePaymentAttemptViaAdvice({
      db: env.PLATFORM_DB,
      autolarisClient: mockClient,
      attemptId: begun.attempt.id,
      settlementPolicy: MOCK_POLICY,
      mediaBucket: env.MEDIA_BUCKET,
      emailPort: mailSink,
      nowMs: BASE_NOW_MS + 5_000,
    });

    expect(outcome.outcome).toBe("settled");
    expect(outcome.settlementId).not.toBeNull();
    expect(outcome.receiptNumber).toBe("PS-2026-000001");
    expect(outcome.receiptId).toBeTruthy();

    const persisted = await findPaymentReceiptBySettlementId(
      env.PLATFORM_DB,
      outcome.settlementId!,
    );
    expect(persisted).not.toBeNull();
    expect(persisted!.receiptNumber).toBe("PS-2026-000001");
    expect(mailSink.list()).toHaveLength(1);
  });

  it("enforces strict download authorization across tenant payer, agency portal, and 2FA audited console endpoints", async () => {
    const mailSink = createLocalMailSink();

    // 1. Seed direct Tenant A (with owner, admin, editor) and direct Tenant B
    const tenantA = await seedSettledTenant({ includeAdminAndEditor: true });
    const tenantB = await seedSettledTenant();

    // 2. Seed Agency 1 (owns Tenant C) and Agency 2 (separate agency)
    const agency1 = await seedAgency("alpha");
    const agency2 = await seedAgency("beta");
    const tenantC = await seedSettledTenant({
      agencyId: agency1.agencyId,
      agencyOrgId: agency1.agencyOrgId,
      agencyStaffUserId: agency1.agencyStaffUserId,
    });

    const [recA, recB, recC] = await Promise.all([
      issueAndDeliverSettlementReceipt({
        db: env.PLATFORM_DB,
        mediaBucket: env.MEDIA_BUCKET,
        settlementId: tenantA.settlementId,
        emailPort: mailSink,
        nowMs: BASE_NOW_MS,
      }),
      issueAndDeliverSettlementReceipt({
        db: env.PLATFORM_DB,
        mediaBucket: env.MEDIA_BUCKET,
        settlementId: tenantB.settlementId,
        emailPort: mailSink,
        nowMs: BASE_NOW_MS + 1_000,
      }),
      issueAndDeliverSettlementReceipt({
        db: env.PLATFORM_DB,
        mediaBucket: env.MEDIA_BUCKET,
        settlementId: tenantC.settlementId,
        emailPort: mailSink,
        nowMs: BASE_NOW_MS + 2_000,
      }),
    ]);

    const appEnv = buildAppEnv();
    const agencyEnv = buildAgencyEnv();
    const consoleEnv = buildConsoleEnv();

    // --- Tenant Endpoint Checks ---

    // Direct owner -> 200 list & 200 PDF with strict security headers
    const ownerListRes = await handleTenantBillingReceiptsListRequest(
      tenantA.tenantId,
      new Request(`${APP_ORIGIN}/api/tenants/${tenantA.tenantId}/billing/receipts`),
      appEnv,
      { authenticatedUser: { id: tenantA.ownerUserId }, nowMs: BASE_NOW_MS },
    );
    expect(ownerListRes.status).toBe(200);
    const ownerListBody = (await ownerListRes.json()) as {
      readonly receipts: readonly { readonly id: string; readonly receiptNumber: string }[];
    };
    expect(ownerListBody.receipts).toHaveLength(1);
    expect(ownerListBody.receipts[0]!.id).toBe(recA.receipt.id);

    const ownerPdfRes = await handleTenantBillingReceiptPdfRequest(
      tenantA.tenantId,
      recA.receipt.id,
      new Request(
        `${APP_ORIGIN}/api/tenants/${tenantA.tenantId}/billing/receipts/${recA.receipt.id}/pdf`,
      ),
      appEnv,
      { authenticatedUser: { id: tenantA.ownerUserId }, nowMs: BASE_NOW_MS },
    );
    expect(ownerPdfRes.status).toBe(200);
    expect(ownerPdfRes.headers.get("content-type")).toBe("application/pdf");
    expect(ownerPdfRes.headers.get("content-disposition")).toBe(
      `attachment; filename="${recA.receipt.receiptNumber}.pdf"`,
    );
    expect(ownerPdfRes.headers.get("cache-control")).toBe("private, no-store");
    expect(ownerPdfRes.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(ownerPdfRes.headers.get("x-content-type-options")).toBe("nosniff");
    const ownerPdfBytes = new Uint8Array(await ownerPdfRes.arrayBuffer());
    expect(await computeSha256Hex(ownerPdfBytes)).toBe(recA.receipt.pdfSha256);

    // Tenant admin -> 403
    const adminPdfRes = await handleTenantBillingReceiptPdfRequest(
      tenantA.tenantId,
      recA.receipt.id,
      new Request(
        `${APP_ORIGIN}/api/tenants/${tenantA.tenantId}/billing/receipts/${recA.receipt.id}/pdf`,
      ),
      appEnv,
      { authenticatedUser: { id: tenantA.adminUserId! }, nowMs: BASE_NOW_MS },
    );
    expect(adminPdfRes.status).toBe(403);

    // Tenant editor -> 403
    const editorPdfRes = await handleTenantBillingReceiptPdfRequest(
      tenantA.tenantId,
      recA.receipt.id,
      new Request(
        `${APP_ORIGIN}/api/tenants/${tenantA.tenantId}/billing/receipts/${recA.receipt.id}/pdf`,
      ),
      appEnv,
      { authenticatedUser: { id: tenantA.editorUserId! }, nowMs: BASE_NOW_MS },
    );
    expect(editorPdfRes.status).toBe(403);

    // Cross-tenant ownerB accessing tenantA -> neutral 404
    const crossTenantRes = await handleTenantBillingReceiptPdfRequest(
      tenantA.tenantId,
      recA.receipt.id,
      new Request(
        `${APP_ORIGIN}/api/tenants/${tenantA.tenantId}/billing/receipts/${recA.receipt.id}/pdf`,
      ),
      appEnv,
      { authenticatedUser: { id: tenantB.ownerUserId }, nowMs: BASE_NOW_MS },
    );
    expect(crossTenantRes.status).toBe(404);

    // ownerA accessing tenantA route with tenantB's receiptId -> neutral 404
    const crossReceiptIdRes = await handleTenantBillingReceiptPdfRequest(
      tenantA.tenantId,
      recB.receipt.id,
      new Request(
        `${APP_ORIGIN}/api/tenants/${tenantA.tenantId}/billing/receipts/${recB.receipt.id}/pdf`,
      ),
      appEnv,
      { authenticatedUser: { id: tenantA.ownerUserId }, nowMs: BASE_NOW_MS },
    );
    expect(crossReceiptIdRes.status).toBe(404);

    // Agency-managed tenant C: owning agency staff -> 200 PDF
    const agencyOnTenantRes = await handleTenantBillingReceiptPdfRequest(
      tenantC.tenantId,
      recC.receipt.id,
      new Request(
        `${APP_ORIGIN}/api/tenants/${tenantC.tenantId}/billing/receipts/${recC.receipt.id}/pdf`,
      ),
      appEnv,
      { authenticatedUser: { id: agency1.agencyStaffUserId }, nowMs: BASE_NOW_MS },
    );
    expect(agencyOnTenantRes.status).toBe(200);
    expect(agencyOnTenantRes.headers.get("content-type")).toBe("application/pdf");

    // Agency-managed tenant C: client's own owner -> 403 (agency is sole payer!)
    const clientOwnerOnAgencyTenantRes = await handleTenantBillingReceiptPdfRequest(
      tenantC.tenantId,
      recC.receipt.id,
      new Request(
        `${APP_ORIGIN}/api/tenants/${tenantC.tenantId}/billing/receipts/${recC.receipt.id}/pdf`,
      ),
      appEnv,
      { authenticatedUser: { id: tenantC.ownerUserId }, nowMs: BASE_NOW_MS },
    );
    expect(clientOwnerOnAgencyTenantRes.status).toBe(403);

    // Other agency (Agency 2) accessing Agency 1's tenant C -> neutral 404
    const otherAgencyOnTenantRes = await handleTenantBillingReceiptPdfRequest(
      tenantC.tenantId,
      recC.receipt.id,
      new Request(
        `${APP_ORIGIN}/api/tenants/${tenantC.tenantId}/billing/receipts/${recC.receipt.id}/pdf`,
      ),
      appEnv,
      { authenticatedUser: { id: agency2.agencyStaffUserId }, nowMs: BASE_NOW_MS },
    );
    expect(otherAgencyOnTenantRes.status).toBe(404);

    // --- Agency Endpoint Checks (/api/agency/receipts & /pdf) ---

    const agencyListRes = await handleAgencyReceiptsListRequest(
      new Request(`${APP_ORIGIN}/api/agency/receipts`),
      agencyEnv,
      { authenticatedUser: { id: agency1.agencyStaffUserId }, nowMs: BASE_NOW_MS },
    );
    expect(agencyListRes.status).toBe(200);
    const agencyListBody = (await agencyListRes.json()) as {
      readonly receipts: readonly { readonly id: string }[];
    };
    expect(agencyListBody.receipts.map((r) => r.id)).toEqual([recC.receipt.id]);

    const agencyPdfRes = await handleAgencyReceiptPdfRequest(
      recC.receipt.id,
      new Request(`${APP_ORIGIN}/api/agency/receipts/${recC.receipt.id}/pdf`),
      agencyEnv,
      { authenticatedUser: { id: agency1.agencyStaffUserId }, nowMs: BASE_NOW_MS },
    );
    expect(agencyPdfRes.status).toBe(200);
    expect(agencyPdfRes.headers.get("content-type")).toBe("application/pdf");

    // Agency 2 cannot download Agency 1's receipt -> neutral 404
    const otherAgencyPdfRes = await handleAgencyReceiptPdfRequest(
      recC.receipt.id,
      new Request(`${APP_ORIGIN}/api/agency/receipts/${recC.receipt.id}/pdf`),
      agencyEnv,
      { authenticatedUser: { id: agency2.agencyStaffUserId }, nowMs: BASE_NOW_MS },
    );
    expect(otherAgencyPdfRes.status).toBe(404);

    // Agency 1 cannot download a direct tenant's receipt -> neutral 404
    const agencyDirectPdfRes = await handleAgencyReceiptPdfRequest(
      recA.receipt.id,
      new Request(`${APP_ORIGIN}/api/agency/receipts/${recA.receipt.id}/pdf`),
      agencyEnv,
      { authenticatedUser: { id: agency1.agencyStaffUserId }, nowMs: BASE_NOW_MS },
    );
    expect(agencyDirectPdfRes.status).toBe(404);

    // Non-agency user on /api/agency/receipts -> 403
    const nonAgencyRes = await handleAgencyReceiptsListRequest(
      new Request(`${APP_ORIGIN}/api/agency/receipts`),
      agencyEnv,
      { authenticatedUser: { id: tenantA.ownerUserId }, nowMs: BASE_NOW_MS },
    );
    expect(nonAgencyRes.status).toBe(403);

    // --- Console Endpoint Checks (/api/console/billing/receipts/[receiptId]/pdf) ---

    const consoleAuth = createConsoleAuth();
    const operator = await createTwoFactorEnrolledOperatorFixture(env.PLATFORM_DB, {
      auth: consoleAuth,
      email: "console-pdf-t081@punyasitus.com",
      name: "Console PDF Op",
      password: "ConsolePassword!2026",
      nowMs: BASE_NOW_MS,
    });

    // Active 2FA console operator on console host -> 200 PDF + platform_audit row!
    const consolePdfRes = await handleConsoleBillingReceiptPdfRequest(
      recA.receipt.id,
      new Request(`${CONSOLE_ORIGIN}/api/console/billing/receipts/${recA.receipt.id}/pdf`, {
        headers: { Cookie: operator.cookieHeader },
      }),
      consoleEnv,
      { nowMs: BASE_NOW_MS + DEFAULT_SECOND_FACTOR_WINDOW_MS / 2 },
    );
    expect(consolePdfRes.status).toBe(200);
    expect(consolePdfRes.headers.get("content-type")).toBe("application/pdf");
    expect(consolePdfRes.headers.get("content-disposition")).toBe(
      `attachment; filename="${recA.receipt.receiptNumber}.pdf"`,
    );
    const consolePdfBytes = new Uint8Array(await consolePdfRes.arrayBuffer());
    expect(await computeSha256Hex(consolePdfBytes)).toBe(recA.receipt.pdfSha256);

    const audits = await listPlatformAuditEntries(env.PLATFORM_DB, {
      action: "console.billing.receipt_downloaded",
      targetId: recA.receipt.id,
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]!.actorUserId).toBe(operator.user.id);
    expect(audits[0]!.tenantId).toBe(tenantA.tenantId);
    expect(audits[0]!.outcome).toBe("success");

    // Non-console hosts (app & tenant host) on console endpoint -> neutral 404!
    const consoleOnAppHost = await handleConsoleBillingReceiptPdfRequest(
      recA.receipt.id,
      new Request(`${APP_ORIGIN}/api/console/billing/receipts/${recA.receipt.id}/pdf`, {
        headers: { Cookie: operator.cookieHeader },
      }),
      consoleEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(consoleOnAppHost.status).toBe(404);

    const consoleOnTenantHost = await handleConsoleBillingReceiptPdfRequest(
      recA.receipt.id,
      new Request(`${TENANT_ORIGIN}/api/console/billing/receipts/${recA.receipt.id}/pdf`, {
        headers: { Cookie: operator.cookieHeader },
      }),
      consoleEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(consoleOnTenantHost.status).toBe(404);

    // Suspended agency MUST be denied on tenant receipt route (403)
    await env.PLATFORM_DB.prepare("UPDATE agencies SET status = 'suspended' WHERE id = ?")
      .bind(agency1.agencyId)
      .run();
    const suspendedAgencyRes = await handleTenantBillingReceiptPdfRequest(
      tenantC.tenantId,
      recC.receipt.id,
      new Request(
        `${APP_ORIGIN}/api/tenants/${tenantC.tenantId}/billing/receipts/${recC.receipt.id}/pdf`,
      ),
      appEnv,
      { authenticatedUser: { id: agency1.agencyStaffUserId }, nowMs: BASE_NOW_MS },
    );
    expect(suspendedAgencyRes.status).toBe(403);

    // Restore agency1 active and test structured 409 + private headers when R2 PDF bytes are tampered
    await env.PLATFORM_DB.prepare("UPDATE agencies SET status = 'active' WHERE id = ?")
      .bind(agency1.agencyId)
      .run();
    await env.MEDIA_BUCKET.put(recA.receipt.r2ObjectKey, new TextEncoder().encode("corrupted"));
    await env.MEDIA_BUCKET.put(recC.receipt.r2ObjectKey, new TextEncoder().encode("corrupted"));

    const tamperedTenantPdf = await handleTenantBillingReceiptPdfRequest(
      tenantA.tenantId,
      recA.receipt.id,
      new Request(
        `${APP_ORIGIN}/api/tenants/${tenantA.tenantId}/billing/receipts/${recA.receipt.id}/pdf`,
      ),
      appEnv,
      { authenticatedUser: { id: tenantA.ownerUserId }, nowMs: BASE_NOW_MS },
    );
    expect(tamperedTenantPdf.status).toBe(409);
    expect(tamperedTenantPdf.headers.get("cache-control")).toBe("private, no-store");
    expect(tamperedTenantPdf.headers.get("x-robots-tag")).toBe("noindex, nofollow");

    const tamperedAgencyPdf = await handleAgencyReceiptPdfRequest(
      recC.receipt.id,
      new Request(`${APP_ORIGIN}/api/agency/receipts/${recC.receipt.id}/pdf`),
      agencyEnv,
      { authenticatedUser: { id: agency1.agencyStaffUserId }, nowMs: BASE_NOW_MS },
    );
    expect(tamperedAgencyPdf.status).toBe(409);
    expect(tamperedAgencyPdf.headers.get("cache-control")).toBe("private, no-store");
    expect(tamperedAgencyPdf.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });

  it("registers billing.receipt.deliver in createBillingJobRegistry, throws retryable errors on transient/unknown email failures, skips permanent suppression, and recovers missing receipts on already_settled", async () => {
    const seeded = await seedSettledTenant();

    // 1. Transient email failure -> throws ReceiptDeliveryRetryableError; receipt & R2 stay intact, emailed_at stays NULL
    const transientFailEmailPort: EmailPort = {
      provider: "cloudflare",
      send: async () => ({
        outcome: "failed",
        provider: "cloudflare",
        errorCode: "E_RATE_LIMITED",
        retryable: true,
        suppressed: false,
      }),
    };

    const registryFail = createBillingJobRegistry({
      emailPort: transientFailEmailPort,
      now: () => BASE_NOW_MS + 10_000,
    });
    const handlerFail = registryFail[BILLING_RECEIPT_DELIVERY_TOPIC];
    expect(handlerFail).toBeDefined();

    await expect(
      handlerFail!.execute({
        idempotencyKey: `deliver:${seeded.settlementId}`,
        topic: BILLING_RECEIPT_DELIVERY_TOPIC,
        tenantId: seeded.tenantId,
        payload: { settlementId: seeded.settlementId },
        attempt: 1,
        maxAttempts: 3,
        correlationId: "corr-1",
        enqueuedAt: BASE_NOW_MS,
        env: {
          PLATFORM_DB: env.PLATFORM_DB,
          MEDIA_BUCKET: env.MEDIA_BUCKET,
          PLATFORM_DOMAIN: "punyasitus.com",
        },
        nowMs: BASE_NOW_MS + 10_000,
      }),
    ).rejects.toBeInstanceOf(ReceiptDeliveryRetryableError);

    const afterTransient = await findPaymentReceiptBySettlementId(
      env.PLATFORM_DB,
      seeded.settlementId,
    );
    expect(afterTransient).not.toBeNull();
    expect(afterTransient!.emailedAtMs).toBeNull();
    expect(await env.MEDIA_BUCKET.get(afterTransient!.r2ObjectKey)).not.toBeNull();

    // 2. Unknown timeout outcome -> also throws ReceiptDeliveryRetryableError
    const unknownEmailPort: EmailPort = {
      provider: "cloudflare",
      send: async () => ({
        outcome: "unknown",
        provider: "cloudflare",
        errorCode: "E_PROVIDER_TIMEOUT",
      }),
    };
    const handlerUnknown = createBillingJobRegistry({
      emailPort: unknownEmailPort,
      now: () => BASE_NOW_MS + 20_000,
    })[BILLING_RECEIPT_DELIVERY_TOPIC]!;
    await expect(
      handlerUnknown.execute({
        idempotencyKey: `deliver:${seeded.settlementId}`,
        topic: BILLING_RECEIPT_DELIVERY_TOPIC,
        tenantId: seeded.tenantId,
        payload: { settlementId: seeded.settlementId },
        attempt: 2,
        maxAttempts: 3,
        correlationId: "corr-1",
        enqueuedAt: BASE_NOW_MS,
        env: {
          PLATFORM_DB: env.PLATFORM_DB,
          MEDIA_BUCKET: env.MEDIA_BUCKET,
          PLATFORM_DOMAIN: "punyasitus.com",
        },
        nowMs: BASE_NOW_MS + 20_000,
      }),
    ).rejects.toBeInstanceOf(ReceiptDeliveryRetryableError);

    // 3. Permanent suppression -> completes cleanly WITHOUT throwing (no useless retry)
    const suppressedEmailPort: EmailPort = {
      provider: "cloudflare",
      send: async () => ({
        outcome: "failed",
        provider: "cloudflare",
        errorCode: "E_RECIPIENT_SUPPRESSED",
        retryable: false,
        suppressed: true,
      }),
    };
    const handlerSuppressed = createBillingJobRegistry({
      emailPort: suppressedEmailPort,
      now: () => BASE_NOW_MS + 25_000,
    })[BILLING_RECEIPT_DELIVERY_TOPIC]!;
    await expect(
      handlerSuppressed.execute({
        idempotencyKey: `deliver:${seeded.settlementId}`,
        topic: BILLING_RECEIPT_DELIVERY_TOPIC,
        tenantId: seeded.tenantId,
        payload: { settlementId: seeded.settlementId },
        attempt: 3,
        maxAttempts: 3,
        correlationId: "corr-1",
        enqueuedAt: BASE_NOW_MS,
        env: {
          PLATFORM_DB: env.PLATFORM_DB,
          MEDIA_BUCKET: env.MEDIA_BUCKET,
          PLATFORM_DOMAIN: "punyasitus.com",
        },
        nowMs: BASE_NOW_MS + 25_000,
      }),
    ).resolves.toBeUndefined();

    // 4. already_settled recovery in reconcilePaymentAttemptViaAdvice issues missing receipt idempotently
    const seededMissing = await seedSettledTenant();
    expect(
      await findPaymentReceiptBySettlementId(env.PLATFORM_DB, seededMissing.settlementId),
    ).toBeNull();

    const mailSink = createLocalMailSink();
    const dummyClient: AutoLarisBillingClient = {
      providerAccountId: "acct-t081",
      relayOrigin: "https://autolaris-relay.punyasitus.com",
      listPaymentChannels: async () => [],
      submitDigitalSubscriptionOrder: async () => {
        throw new Error("not used");
      },
      checkTransactionAdvice: async () => {
        throw new Error("not used for already_settled");
      },
    };

    const recovered = await reconcilePaymentAttemptViaAdvice({
      db: env.PLATFORM_DB,
      autolarisClient: dummyClient,
      attemptId: seededMissing.attemptId,
      settlementPolicy: MOCK_POLICY,
      mediaBucket: env.MEDIA_BUCKET,
      emailPort: mailSink,
      nowMs: BASE_NOW_MS + 30_000,
    });
    expect(recovered.outcome).toBe("already_settled");
    expect(recovered.receiptNumber).toBe("PS-2026-000002");
    expect(
      await findPaymentReceiptBySettlementId(env.PLATFORM_DB, seededMissing.settlementId),
    ).not.toBeNull();
    expect(mailSink.list()).toHaveLength(1);

    // 5. Enqueue path when jobsQueue is provided without mediaBucket
    const seededQueued = await seedSettledTenant();
    const queuedMessages: unknown[] = [];
    const enqueueOutcome = await reconcilePaymentAttemptViaAdvice({
      db: env.PLATFORM_DB,
      autolarisClient: dummyClient,
      attemptId: seededQueued.attemptId,
      settlementPolicy: MOCK_POLICY,
      jobsQueue: {
        send: async (msg) => {
          queuedMessages.push(msg);
        },
      },
      nowMs: BASE_NOW_MS + 40_000,
    });
    expect(enqueueOutcome.outcome).toBe("already_settled");
    expect(queuedMessages).toHaveLength(1);
    expect(queuedMessages[0]).toMatchObject({
      topic: BILLING_RECEIPT_DELIVERY_TOPIC,
      tenantId: seededQueued.tenantId,
      payload: { settlementId: seededQueued.settlementId },
    });
  });

  it("refuses R2 write when pdfBytes SHA-256 mismatches expectedSha256Hex, enforces accounting sum without sequence gaps, and gracefully defers credit note on R2 failure during refund", async () => {
    // 1. Pre-write SHA-256 verification prevents writing corrupted bytes to a brand-new R2 key
    const badKey = "platform/receipts/2026/PS-2026-000999.pdf";
    await expect(
      storeReceiptPdfImmutably(env.MEDIA_BUCKET, {
        objectKey: badKey,
        receiptNumber: "PS-2026-000999",
        documentKind: "receipt",
        pdfBytes: new TextEncoder().encode("%PDF-1.7 mismatched"),
        expectedSha256Hex: "a".repeat(64),
      }),
    ).rejects.toThrow(/tidak cocok sebelum disimpan/i);
    expect(await env.MEDIA_BUCKET.get(badKey)).toBeNull();

    // 2. Mismatched accounting sum (base - discount + fee !== total) rejects cleanly WITHOUT bumping counter
    const seeded = await seedSettledTenant();
    await expect(
      allocateAndInsertPaymentReceipt(env.PLATFORM_DB, {
        documentKind: "receipt",
        tenantId: seeded.tenantId,
        agencyId: null,
        obligationId: seeded.obligationId,
        settlementId: seeded.settlementId,
        refundId: null,
        linkedReceiptId: null,
        payerUserId: seeded.ownerUserId,
        baseAmountIdr: 179_000,
        discountAmountIdr: 10_000,
        channelFeeIdr: 3_000,
        totalAmountIdr: 999_000, // Mismatch! Expected 172_000
        planCode: "monthly",
        periodStartMs: BASE_NOW_MS,
        periodEndMs: BASE_NOW_MS + 30 * DAY_MS,
        paymentChannel: "VA (VAMANDIRI)",
        providerReference: "REF-MISMATCH",
        issuedAtMs: BASE_NOW_MS,
        nowMs: BASE_NOW_MS,
        buildPdf: async (receiptNumber) =>
          generateReceiptPdf({
            documentKind: "receipt",
            receiptNumber,
            issuedAtMs: BASE_NOW_MS,
            payerKind: "tenant",
            payerName: "Owner",
            tenantName: "Toko",
            tenantHandle: seeded.handle,
            obligationId: seeded.obligationId,
            settlementId: seeded.settlementId,
            planCode: "monthly",
            baseAmountIdr: 179_000,
            discountAmountIdr: 10_000,
            channelFeeIdr: 3_000,
            totalAmountIdr: 999_000,
            paymentChannel: "VA",
          }),
      }),
    ).rejects.toThrow(/Total kuitansi tidak cocok/i);

    const counterRow = await env.PLATFORM_DB.prepare(
      "SELECT last_seq FROM receipt_yearly_counters WHERE year = 2026",
    ).first<{ readonly last_seq: number }>();
    expect(counterRow).toBeNull(); // Zero counter bump -> zero sequence gap!

    // Direct SQLite CHECK constraint also rejects unbalanced direct INSERT
    await expect(
      env.PLATFORM_DB.prepare(
        `INSERT INTO payment_receipts (
           id, receipt_number, document_kind, tenant_id, agency_id, obligation_id,
           settlement_id, refund_id, linked_receipt_id, payer_user_id, currency,
           base_amount_idr, discount_amount_idr, channel_fee_idr, total_amount_idr,
           plan_code, period_start_ms, period_end_ms, payment_channel, provider_reference,
           r2_object_key, pdf_sha256, pdf_byte_length, non_pkp_notice, issued_at, emailed_at, created_at
         ) VALUES (
           'rcp_bad', 'PS-2026-000099', 'receipt', ?, NULL, ?, ?, NULL, NULL, ?, 'IDR',
           179000, 0, 3000, 179000, 'monthly', NULL, NULL, 'VA', NULL,
           'platform/receipts/2026/PS-2026-000099.pdf', 'abc', 100, 'non-pkp', ?, NULL, ?
         )`,
      )
        .bind(seeded.tenantId, seeded.obligationId, seeded.settlementId, seeded.ownerUserId, BASE_NOW_MS, BASE_NOW_MS)
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/i);

    // 3. Resilient refund credit-note handling: R2 outage during refund still returns 201 + creditNoteDeferred + enqueues delivery job!
    const consoleAuth = createConsoleAuth();
    const operator = await createTwoFactorEnrolledOperatorFixture(env.PLATFORM_DB, {
      auth: consoleAuth,
      email: "resilient-refund-t081@punyasitus.com",
      name: "Resilient Refund Op",
      password: "OperatorPassword!2026",
      nowMs: BASE_NOW_MS,
    });

    const queuedRefundJobs: unknown[] = [];
    const failingBucket = {
      put: async () => {
        throw new Error("R2_TEMPORARY_OUTAGE");
      },
      get: async () => {
        throw new Error("R2_TEMPORARY_OUTAGE");
      },
    } as unknown as R2Bucket;

    const refundRes = await handleConsoleBillingRefundRequest(
      new Request(`${CONSOLE_ORIGIN}/api/console/billing/refund`, {
        method: "POST",
        headers: {
          Cookie: operator.cookieHeader,
          Origin: CONSOLE_ORIGIN,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          obligationId: seeded.obligationId,
          paymentAttemptId: seeded.attemptId,
          tenantId: seeded.tenantId,
          refundKind: "mistaken_payment",
          amountIdr: seeded.totalPayableIdr,
          externalReference: "TRF-OUTAGE-TEST",
          reason: "Pengembalian dana manual saat uji ketahanan R2 outage",
        }),
      }),
      buildConsoleEnv({
        MEDIA_BUCKET: failingBucket,
        JOBS_QUEUE: {
          send: async (msg) => {
            queuedRefundJobs.push(msg);
          },
        },
      }),
      { nowMs: BASE_NOW_MS + 60_000 },
    );

    expect(refundRes.status).toBe(201);
    const refundBody = (await refundRes.json()) as {
      readonly success: boolean;
      readonly refund: { readonly id: string };
      readonly creditNote: unknown;
      readonly creditNoteDeferred?: boolean;
    };
    expect(refundBody.success).toBe(true);
    expect(refundBody.creditNote).toBeNull();
    expect(refundBody.creditNoteDeferred).toBe(true);
    expect(queuedRefundJobs).toHaveLength(1);
    expect(queuedRefundJobs[0]).toMatchObject({
      topic: BILLING_RECEIPT_DELIVERY_TOPIC,
      tenantId: seeded.tenantId,
      payload: { refundId: refundBody.refund.id },
    });
  });
});

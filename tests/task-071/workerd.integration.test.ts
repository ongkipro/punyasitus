import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { createLocalMailSink } from "@punyasitus/core/email/index";
import { addCalendarDaysToIsoDate, containsScheduleFieldKey } from "@punyasitus/core/leads/index";
import {
  applyTenantMigrations,
  createTenantDb,
  openTenantStoreStub,
  type StorageLike,
  type TenantStoreNamespaceLike,
} from "@punyasitus/db/connections";
import {
  applyTenantLeadPreferredScheduleMigrations,
  getLeadById,
  hasLeadPreferredBranchLabelColumn,
  listLeads,
} from "@punyasitus/db/leads/index";
import { createOutlet, deleteOutlet } from "@punyasitus/db/outlets/index";
import { TENANT_MIGRATIONS } from "@punyasitus/db/tenant";
import { describe, expect, it } from "vitest";
import { handlePublicLeadPost } from "../../apps/web/src/pages/api/leads.ts";

const RATE_LIMIT_SALT = "task071-workerd-rate-limit-salt";
const FIXED_NOW_MS = Date.UTC(2026, 10, 23, 18, 30, 0); // 2026-11-24 01:30 WIB, 2026-11-23 18:30 UTC, 2026-11-23 13:30 NY

async function openTenantDbWith0024(tenantId: string): Promise<D1Database> {
  const ns = env.TENANT_STORE as unknown as TenantStoreNamespaceLike;
  const doId = env.TENANT_STORE.idFromName(tenantId);
  const rawDoStub = env.TENANT_STORE.get(doId);
  await runInDurableObject(rawDoStub, (_instance, state) =>
    applyTenantLeadPreferredScheduleMigrations(state.storage as unknown as StorageLike),
  );
  return createTenantDb(openTenantStoreStub(ns, tenantId));
}

async function openLegacyTenantDb0001Only(tenantId: string): Promise<D1Database> {
  const ns = env.TENANT_STORE as unknown as TenantStoreNamespaceLike;
  const doId = env.TENANT_STORE.idFromName(tenantId);
  const rawDoStub = env.TENANT_STORE.get(doId);
  await runInDurableObject(rawDoStub, (_instance, state) =>
    applyTenantMigrations(state.storage as unknown as StorageLike, TENANT_MIGRATIONS),
  );
  return createTenantDb(openTenantStoreStub(ns, tenantId));
}

async function setTenantTimeZone(tenantDb: D1Database, timeZone: string): Promise<void> {
  await tenantDb
    .prepare(
      `INSERT INTO site_settings (id, site_title, timezone, updated_at)
       VALUES (1, 'Klinik Sehat Nusantara', ?, ?)
       ON CONFLICT(id) DO UPDATE SET timezone = excluded.timezone, updated_at = excluded.updated_at`,
    )
    .bind(timeZone, FIXED_NOW_MS)
    .run();
}

function makeJsonLeadRequest(
  host: string,
  payload: Record<string, unknown>,
  options?: { readonly idempotencyKey?: string; readonly ip?: string },
): Request {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Origin: `https://${host}`,
    "CF-Connecting-IP": options?.ip ?? "203.0.113.71",
  };
  if (options?.idempotencyKey) {
    headers["Idempotency-Key"] = options.idempotencyKey;
  }
  return new Request(`https://${host}/api/leads`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
}

function makeFormLeadRequest(
  host: string,
  fields: Record<string, string>,
  options?: { readonly ip?: string },
): Request {
  const params = new URLSearchParams(fields);
  return new Request(`https://${host}/api/leads`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: `https://${host}`,
      "Sec-Fetch-Site": "same-origin",
      "CF-Connecting-IP": options?.ip ?? "203.0.113.72",
    },
    body: params.toString(),
  });
}

describe("TASK-071 workerd integration — Preferred Schedule Fields, Active Branch Isolation, Timezone Bounds & Privacy", () => {
  it("persists preferred schedule on JSON & no-JS form POSTs, enforces active same-tenant branch & tenant timezone bounds, preserves idempotency, keeps snapshot after outlet deletion, and leaks zero schedule data to analytics/emails", async () => {
    const suffix = Date.now().toString(36);
    const tenantAId = `01JT071A${suffix}`;
    const tenantBId = `01JT071B${suffix}`;
    const hostA = `klinik-a-${suffix}.situsku.click`;

    const tenantADb = await openTenantDbWith0024(tenantAId);
    const tenantBDb = await openTenantDbWith0024(tenantBId);

    expect(await hasLeadPreferredBranchLabelColumn(tenantADb)).toBe(true);
    await setTenantTimeZone(tenantADb, "Asia/Jakarta");

    // Seed outlets in Tenant A: 1 active published, 1 draft, 1 inactive
    const activeOutletA = await createOutlet(tenantADb, {
      name: "Cabang Jakarta Selatan",
      address: "Jl. Kemang Raya No. 12, Jakarta Selatan",
      status: "published",
      active: true,
    });
    const draftOutletA = await createOutlet(tenantADb, {
      name: "Cabang Draft Bekasi",
      address: "Jl. Ahmad Yani No. 8, Bekasi",
      status: "draft",
      active: true,
    });
    const inactiveOutletA = await createOutlet(tenantADb, {
      name: "Cabang Nonaktif Depok",
      address: "Jl. Margonda Raya No. 10, Depok",
      status: "published",
      active: false,
    });

    // Seed 4 outlets in Tenant B so Tenant B has an active outlet ID (4) that does NOT exist in Tenant A
    for (let i = 1; i <= 4; i += 1) {
      await createOutlet(tenantBDb, {
        name: `Cabang Tenant B #${i}`,
        address: `Jl. Merdeka No. ${i}, Bandung`,
        status: "published",
        active: true,
      });
    }

    const mailSink = createLocalMailSink();
    const baseDeps = {
      surface: "tenant" as const,
      tenant: {
        id: tenantAId,
        handle: `klinik-a-${suffix}`,
        name: "Klinik Sehat A",
        host: hostA,
        status: "active" as const,
      },
      tenantDb: tenantADb,
      emailPort: mailSink,
      ownerEmail: "owner@klinik-a.example",
      appEnv: "test",
      rateLimitSalt: RATE_LIMIT_SALT,
      rateLimitPolicy: {
        perNetworkMinute: { name: "lead_net_min", limit: 50, windowMs: 60_000 },
        perTenantHour: { name: "lead_tenant_hr", limit: 200, windowMs: 3_600_000 },
      },
      nowMs: FIXED_NOW_MS,
    };

    // 1. Past date in Asia/Jakarta (2026-11-23 when Jakarta is already 2026-11-24 01:30) -> 422 DATE_IN_PAST
    const pastRes = await handlePublicLeadPost(
      makeJsonLeadRequest(hostA, {
        name: "Budi Santoso",
        phone: "0812-3456-7890",
        message: "Ingin periksa gigi",
        privacyConsent: true,
        preferred_date: "2026-11-23",
        preferred_time: "pagi",
        branch_id: activeOutletA.id,
      }),
      baseDeps,
    );
    expect(pastRes.status).toBe(422);
    const pastBody = (await pastRes.json()) as { error: { fields: Array<{ code: string }> } };
    expect(pastBody.error.fields.some((f) => f.code === "DATE_IN_PAST")).toBe(true);

    // 2. Date beyond +180 days -> 422 DATE_TOO_FAR
    const tooFarDate = addCalendarDaysToIsoDate("2026-11-24", 181);
    const farRes = await handlePublicLeadPost(
      makeJsonLeadRequest(hostA, {
        name: "Budi Santoso",
        phone: "0812-3456-7890",
        message: "Ingin periksa gigi",
        privacyConsent: true,
        preferred_date: tooFarDate,
      }),
      baseDeps,
    );
    expect(farRes.status).toBe(422);
    const farBody = (await farRes.json()) as { error: { fields: Array<{ code: string }> } };
    expect(farBody.error.fields.some((f) => f.code === "DATE_TOO_FAR")).toBe(true);

    // 3. Invalid preferred_time -> 422 INVALID_PREFERRED_TIME
    const badTimeRes = await handlePublicLeadPost(
      makeJsonLeadRequest(hostA, {
        name: "Budi Santoso",
        phone: "0812-3456-7890",
        message: "Ingin periksa gigi",
        privacyConsent: true,
        preferred_time: "subuh",
      }),
      baseDeps,
    );
    expect(badTimeRes.status).toBe(422);
    const badTimeBody = (await badTimeRes.json()) as { error: { fields: Array<{ code: string }> } };
    expect(badTimeBody.error.fields.some((f) => f.code === "INVALID_PREFERRED_TIME")).toBe(true);

    // 4. Draft, inactive, and cross-tenant/non-existent branch_id -> 422 INVALID_BRANCH
    for (const badBranchId of [draftOutletA.id, inactiveOutletA.id, 4, 9999]) {
      const badBranchRes = await handlePublicLeadPost(
        makeJsonLeadRequest(hostA, {
          name: "Budi Santoso",
          phone: "0812-3456-7890",
          message: "Ingin periksa gigi",
          privacyConsent: true,
          branch_id: badBranchId,
        }),
        baseDeps,
      );
      expect(badBranchRes.status).toBe(422);
      const body = (await badBranchRes.json()) as { error: { fields: Array<{ code: string }> } };
      expect(body.error.fields.some((f) => f.code === "INVALID_BRANCH")).toBe(true);
    }

    // 5. Unknown field rejected with 422 UNKNOWN_FIELD
    const unknownFieldRes = await handlePublicLeadPost(
      makeJsonLeadRequest(hostA, {
        name: "Budi Santoso",
        phone: "0812-3456-7890",
        message: "Ingin periksa gigi",
        privacyConsent: true,
        preferred_date: "2026-12-01",
        booking_slot: "09:00",
      }),
      baseDeps,
    );
    expect(unknownFieldRes.status).toBe(422);
    const unknownBody = (await unknownFieldRes.json()) as {
      error: { fields: Array<{ field: string; code: string }> };
    };
    expect(unknownBody.error.fields.some((f) => f.field === "booking_slot" && f.code === "UNKNOWN_FIELD")).toBe(
      true,
    );

    // 6. Oversized >16 KiB JSON and form-encoded payloads rejected with 413 PAYLOAD_TOO_LARGE
    const hugeJsonRes = await handlePublicLeadPost(
      makeJsonLeadRequest(hostA, {
        name: "Budi",
        phone: "0812-3456-7890",
        message: "x".repeat(17_000),
        preferred_date: "2026-12-01",
        privacyConsent: true,
      }),
      baseDeps,
    );
    expect(hugeJsonRes.status).toBe(413);

    const hugeFormRes = await handlePublicLeadPost(
      makeFormLeadRequest(hostA, {
        name: "Budi",
        phone: "0812-3456-7890",
        message: "y".repeat(17_000),
        preferred_date: "2026-12-01",
        privacyConsent: "true",
      }),
      baseDeps,
    );
    expect(hugeFormRes.status).toBe(413);

    // 7. Valid JSON submission with schedule fields + Idempotency-Key -> 201 Created, replay 201, conflict 409
    const idemKey = "71717171-7171-4171-8171-717171717171";
    const validPayload = {
      name: "Siti Rahmawati",
      phone: "0812-3456-7890",
      email: "siti@example.test",
      message: "Mohon jadwal konsultasi perawatan gigi.",
      privacyConsent: true,
      preferred_date: "2026-12-10",
      preferred_time: "pagi",
      branch_id: activeOutletA.id,
      sourcePath: "/kontak",
    };

    const createRes = await handlePublicLeadPost(
      makeJsonLeadRequest(hostA, validPayload, { idempotencyKey: idemKey }),
      baseDeps,
    );
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { leadNumber: number; status: string };
    expect(created.status).toBe("accepted");
    expect(created.leadNumber).toBe(1);

    // Exact replay returns same leadNumber without creating duplicate row
    const replayRes = await handlePublicLeadPost(
      makeJsonLeadRequest(hostA, validPayload, { idempotencyKey: idemKey }),
      baseDeps,
    );
    expect(replayRes.status).toBe(201);
    const replayed = (await replayRes.json()) as { leadNumber: number };
    expect(replayed.leadNumber).toBe(1);

    // Changed preferred_time under same Idempotency-Key -> 409 IDEMPOTENCY_CONFLICT
    const conflictRes = await handlePublicLeadPost(
      makeJsonLeadRequest(
        hostA,
        { ...validPayload, preferred_time: "malam" },
        { idempotencyKey: idemKey },
      ),
      baseDeps,
    );
    expect(conflictRes.status).toBe(409);

    // 8. Valid no-JS form-encoded submission -> 303 See Other with ZERO schedule values in Location URL!
    const maxValidDate = addCalendarDaysToIsoDate("2026-11-24", 180);
    const formRes = await handlePublicLeadPost(
      makeFormLeadRequest(hostA, {
        name: "Andi Wijaya",
        phone: "+62 813-9876-5432",
        message: "Permintaan jadwal pemeriksaan dari form no-JS.",
        privacyConsent: "true",
        preferred_date: maxValidDate,
        preferred_time: "sore",
        branch_id: String(activeOutletA.id),
        sourcePath: "/kontak",
        returnTo: "/kontak",
      }),
      baseDeps,
    );
    expect(formRes.status).toBe(303);
    const location = formRes.headers.get("Location") ?? "";
    expect(location).toContain("leadStatus=accepted");
    expect(location).toContain("leadNumber=2");
    expect(location).not.toContain(maxValidDate);
    expect(location).not.toContain("sore");
    expect(location).not.toContain("Jakarta");

    // 9. Timezone switch on tenant (`America/New_York` where 2026-11-23 is still TODAY) does NOT shift stored dates
    await setTenantTimeZone(tenantADb, "America/New_York");
    const nyTodayRes = await handlePublicLeadPost(
      makeJsonLeadRequest(hostA, {
        name: "Dewi NY",
        phone: "0815-1111-2222",
        message: "Cek batas tanggal timezone NY",
        privacyConsent: true,
        preferred_date: "2026-11-23",
        preferred_time: "malam",
      }),
      baseDeps,
    );
    expect(nyTodayRes.status).toBe(201);

    // Verify previously stored date-only values remained exact and unshifted!
    const storedLead1 = await getLeadById(tenantADb, 1);
    expect(storedLead1?.preferredDate).toBe("2026-12-10");
    expect(storedLead1?.preferredTime).toBe("pagi");
    expect(storedLead1?.branchId).toBe(activeOutletA.id);
    expect(storedLead1?.preferredBranchLabel).toBe("Cabang Jakarta Selatan");

    const storedLead2 = await getLeadById(tenantADb, 2);
    expect(storedLead2?.preferredDate).toBe(maxValidDate);
    expect(storedLead2?.preferredTime).toBe("sore");
    expect(storedLead2?.preferredBranchLabel).toBe("Cabang Jakarta Selatan");

    // 10. Deleting the outlet detaches leads.branch_id to NULL, yet preferredBranchLabel snapshot survives!
    await deleteOutlet(tenantADb, activeOutletA.id);
    const afterDeleteList = await listLeads(tenantADb, { status: "all", limit: 10 });
    const lead1AfterDelete = afterDeleteList.items.find((l) => l.id === 1);
    expect(lead1AfterDelete?.branchId).toBeNull();
    expect(lead1AfterDelete?.preferredBranchLabel).toBe("Cabang Jakarta Selatan");

    // 11. Privacy & telemetry audit: zero schedule values in analytics_daily, owner emails, or activity logs
    const analyticsRows = await tenantADb
      .prepare("SELECT * FROM analytics_daily")
      .all<Record<string, unknown>>();
    const analyticsJson = JSON.stringify(analyticsRows.results ?? []);
    expect(analyticsJson).not.toContain("2026-12-10");
    expect(analyticsJson).not.toContain("pagi");
    expect(analyticsJson).not.toContain("Cabang Jakarta Selatan");
    expect(containsScheduleFieldKey(analyticsRows.results ?? [])).toBe(false);

    const sentMails = mailSink.list();
    expect(sentMails.length).toBeGreaterThanOrEqual(2);
    for (const mail of sentMails) {
      const text = `${mail.subject}\n${mail.html}\n${mail.text}`;
      expect(text).not.toContain("2026-12-10");
      expect(text).not.toContain(maxValidDate);
      expect(text).not.toContain("Cabang Jakarta Selatan");
      expect(text).not.toContain("preferred_date");
    }
  });

  it("remains 100% backward compatible on pre-0024 tenant DBs (0001_initial_tenant only)", async () => {
    const suffix = Date.now().toString(36);
    const legacyTenantId = `01JT071LEGACY${suffix}`;
    const host = `legacy-${suffix}.situsku.click`;
    const legacyDb = await openLegacyTenantDb0001Only(legacyTenantId);

    expect(await hasLeadPreferredBranchLabelColumn(legacyDb)).toBe(false);

    const outlet = await createOutlet(legacyDb, {
      name: "Gerai Utama Legacy",
      address: "Jl. Sudirman No. 1, Jakarta",
      status: "published",
      active: true,
    });

    const res = await handlePublicLeadPost(
      makeJsonLeadRequest(host, {
        name: "Hendra Legacy",
        phone: "0812-9999-0000",
        message: "Halo dari tenant pre-0024",
        privacyConsent: true,
        preferred_date: "2026-12-15",
        preferred_time: "siang",
        branch_id: outlet.id,
      }),
      {
        surface: "tenant",
        tenant: {
          id: legacyTenantId,
          handle: `legacy-${suffix}`,
          name: "Legacy Klinik",
          host,
          status: "active",
        },
        tenantDb: legacyDb,
        appEnv: "test",
        rateLimitSalt: RATE_LIMIT_SALT,
        nowMs: FIXED_NOW_MS,
      },
    );

    expect(res.status).toBe(201);
    const list = await listLeads(legacyDb, { status: "all", limit: 10 });
    expect(list.items).toHaveLength(1);
    expect(list.items[0]?.preferredDate).toBe("2026-12-15");
    expect(list.items[0]?.preferredTime).toBe("siang");
    expect(list.items[0]?.branchId).toBe(outlet.id);
    // Still resolves branch name via LEFT JOIN branches on pre-0024 DBs!
    expect(list.items[0]?.preferredBranchLabel).toBe("Gerai Utama Legacy");
  });

  it("replays matching Idempotency-Key with 201 after midnight and after branch deactivation, while rejecting new keys with 422", async () => {
    const suffix = `${Date.now().toString(36)}r1`;
    const tenantId = `01JT071R1${suffix}`;
    const host = `replay-${suffix}.situsku.click`;
    const tenantDb = await openTenantDbWith0024(tenantId);
    await setTenantTimeZone(tenantDb, "Asia/Jakarta");

    const branch = await createOutlet(tenantDb, {
      name: "Cabang Senopati",
      address: "Jl. Senopati No. 5, Jakarta Selatan",
      status: "published",
      active: true,
    });

    // 2026-11-24 23:30 WIB (`2026-11-24T16:30:00Z`) — "today" in Asia/Jakarta is `2026-11-24`
    const beforeMidnightMs = Date.UTC(2026, 10, 24, 16, 30, 0);
    // Advance +23h across midnight (`2026-11-25 22:30 WIB`, still inside 24h lead_dedup TTL)
    // so `2026-11-24` is now YESTERDAY in Asia/Jakarta!
    const afterMidnightMs = beforeMidnightMs + 23 * 60 * 60 * 1000;

    const idemKey = "99999999-9999-4999-8999-999999999991";
    const payload = {
      name: "Rudi Hartono",
      phone: "0812-7777-8888",
      message: "Permintaan jadwal hari ini menjelang tengah malam.",
      privacyConsent: true,
      preferred_date: "2026-11-24",
      preferred_time: "malam",
      branch_id: branch.id,
      sourcePath: "/kontak",
    };

    const baseDeps = {
      surface: "tenant" as const,
      tenant: {
        id: tenantId,
        handle: `replay-${suffix}`,
        name: "Klinik Replay",
        host,
        status: "active" as const,
      },
      tenantDb,
      appEnv: "test",
      rateLimitSalt: RATE_LIMIT_SALT,
      rateLimitPolicy: {
        perNetworkMinute: { name: "lead_net_min", limit: 50, windowMs: 60_000 },
        perTenantHour: { name: "lead_tenant_hr", limit: 200, windowMs: 3_600_000 },
      },
    };

    // 1. Initial submission succeeds (201)
    const firstRes = await handlePublicLeadPost(
      makeJsonLeadRequest(host, payload, { idempotencyKey: idemKey }),
      { ...baseDeps, nowMs: beforeMidnightMs },
    );
    expect(firstRes.status).toBe(201);
    const firstBody = (await firstRes.json()) as { leadNumber: number; status: string };
    expect(firstBody.leadNumber).toBe(1);

    // 2. Deactivate the branch (`active = 0`) AND cross midnight so `preferred_date` is now in the past
    await tenantDb
      .prepare("UPDATE branches SET active = 0, updated_at = ? WHERE id = ?")
      .bind(afterMidnightMs, branch.id)
      .run();

    // 3. Exact replay of SAME Idempotency-Key + SAME payload STILL returns 201 with original leadNumber (zero duplicate!)
    const replayRes = await handlePublicLeadPost(
      makeJsonLeadRequest(host, payload, { idempotencyKey: idemKey }),
      { ...baseDeps, nowMs: afterMidnightMs },
    );
    expect(replayRes.status).toBe(201);
    const replayBody = (await replayRes.json()) as { leadNumber: number; status: string };
    expect(replayBody.leadNumber).toBe(1);

    const leadsCountRow = await tenantDb
      .prepare("SELECT COUNT(*) AS cnt FROM leads")
      .first<{ readonly cnt: number }>();
    expect(Number(leadsCountRow?.cnt)).toBe(1);

    // 4. Mismatched payload on the SAME Idempotency-Key still returns 409 IDEMPOTENCY_CONFLICT
    const conflictRes = await handlePublicLeadPost(
      makeJsonLeadRequest(
        host,
        { ...payload, message: "Pesan berbeda pada key sama" },
        { idempotencyKey: idemKey },
      ),
      { ...baseDeps, nowMs: afterMidnightMs },
    );
    expect(conflictRes.status).toBe(409);

    // 5. Brand-new Idempotency-Key with the now-past date returns 422 DATE_IN_PAST
    const newKeyPastRes = await handlePublicLeadPost(
      makeJsonLeadRequest(host, payload, {
        idempotencyKey: "99999999-9999-4999-8999-999999999992",
      }),
      { ...baseDeps, nowMs: afterMidnightMs },
    );
    expect(newKeyPastRes.status).toBe(422);
    const pastErr = (await newKeyPastRes.json()) as { error: { fields: Array<{ code: string }> } };
    expect(pastErr.error.fields.some((f) => f.code === "DATE_IN_PAST")).toBe(true);

    // 6. Brand-new Idempotency-Key with a valid future date but the deactivated branch returns 422 INVALID_BRANCH
    const newKeyInactiveBranchRes = await handlePublicLeadPost(
      makeJsonLeadRequest(
        host,
        { ...payload, preferred_date: "2026-11-26" },
        { idempotencyKey: "99999999-9999-4999-8999-999999999993" },
      ),
      { ...baseDeps, nowMs: afterMidnightMs },
    );
    expect(newKeyInactiveBranchRes.status).toBe(422);
    const branchErr = (await newKeyInactiveBranchRes.json()) as {
      error: { fields: Array<{ code: string }> };
    };
    expect(branchErr.error.fields.some((f) => f.code === "INVALID_BRANCH")).toBe(true);
  });
});

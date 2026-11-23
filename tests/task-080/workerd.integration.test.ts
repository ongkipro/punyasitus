import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { APP_SESSION_COOKIE_NAME, createAuth } from "@punyasitus/auth";
import { createLocalMailSink } from "@punyasitus/core/email/index";
import { getFormVerticalTemplate } from "@punyasitus/core/forms/index";
import {
  applyPlatformMigrations,
  applyTenantMigrations,
  createTenantDb,
  openTenantStoreStub,
  type StorageLike,
  type TenantStoreNamespaceLike,
} from "@punyasitus/db/connections";
import { BUSINESS_PROFILE_STRUCTURED_MIGRATION } from "@punyasitus/db/business-profile/migrations";
import { getLeadFormSnapshotById } from "@punyasitus/db/forms/index";
import { CUSTOM_FORMS_MIGRATION } from "@punyasitus/db/forms/migrations";
import { PLATFORM_MIGRATIONS } from "@punyasitus/db/platform";
import { TENANT_MIGRATIONS } from "@punyasitus/db/tenant";
import { describe, expect, it } from "vitest";
import { handlePublicLeadPost } from "../../apps/web/src/pages/api/leads.ts";
import { handleTenantFormDetailRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/forms/[formId].ts";
import { handleTenantFormPublishRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/forms/[formId]/publish.ts";
import { handleTenantFormsCollectionRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/forms/index.ts";
import { handleTenantFormTemplatesRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/forms/templates.ts";
import type { TenantFormsRuntimeEnv } from "../../apps/web/src/pages/api/tenants/[tenantId]/forms/_shared.ts";

const APP_ORIGIN = "https://app.punyasitus.com";
const TEST_SECRET = "task080-workerd-integration-auth-secret-0123456789abcdef";
const TEST_RATE_LIMIT_SALT = "task080-workerd-rate-limit-salt";
const DAY_MS = 24 * 60 * 60 * 1000;

let platformMigrated = false;

async function ensurePlatformMigrated(): Promise<void> {
  if (platformMigrated) return;
  await applyPlatformMigrations(env.PLATFORM_DB, PLATFORM_MIGRATIONS);
  platformMigrated = true;
}

async function openMigratedTenantDb(tenantId: string): Promise<D1Database> {
  const ns = env.TENANT_STORE as unknown as TenantStoreNamespaceLike;
  const doId = env.TENANT_STORE.idFromName(tenantId);
  const rawDoStub = env.TENANT_STORE.get(doId);
  await runInDurableObject(rawDoStub, (_instance, state) =>
    applyTenantMigrations(state.storage as unknown as StorageLike, [
      ...TENANT_MIGRATIONS,
      BUSINESS_PROFILE_STRUCTURED_MIGRATION,
      CUSTOM_FORMS_MIGRATION,
    ]),
  );
  return createTenantDb(openTenantStoreStub(ns, tenantId));
}

async function createSignedInUser(email: string, name: string): Promise<{
  readonly userId: string;
  readonly cookie: string;
}> {
  const auth = createAuth(env.PLATFORM_DB, {
    baseURL: APP_ORIGIN,
    secret: TEST_SECRET,
    surface: "app",
    trustedOrigins: [APP_ORIGIN],
    emailPort: createLocalMailSink(),
  });
  const res = await auth.handler(
    new Request(`${APP_ORIGIN}/api/auth/sign-up/email`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: APP_ORIGIN,
      },
      body: JSON.stringify({
        email,
        password: "Task080Password!2026",
        name,
      }),
    }),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { user?: { id?: string } };
  const userId = body.user?.id ?? "";
  expect(userId.length).toBeGreaterThan(0);

  const rawCookie = res.headers.get("set-cookie") ?? "";
  const match = rawCookie.match(new RegExp(`${APP_SESSION_COOKIE_NAME}=[^;]+`));
  expect(match).not.toBeNull();
  return { userId, cookie: match![0] };
}

function makeRuntimeEnv(overrides?: Partial<TenantFormsRuntimeEnv>): TenantFormsRuntimeEnv {
  return {
    APP_ENV: "test",
    PLATFORM_DOMAIN: "punyasitus.com",
    SAAS_ZONE: "situsku.click",
    PLATFORM_DB: env.PLATFORM_DB,
    AUTH_SECRET: TEST_SECRET,
    TENANT_STORE: env.TENANT_STORE as unknown as TenantStoreNamespaceLike,
    ...overrides,
  };
}

function makeAdminRequest(
  pathname: string,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  cookie: string,
  body?: unknown,
  origin: string = APP_ORIGIN,
): Request {
  const headers: Record<string, string> = {
    Cookie: cookie,
    Accept: "application/json",
  };
  if (method !== "GET") {
    headers["Content-Type"] = "application/json";
    headers.Origin = origin;
  }
  return new Request(`${origin}${pathname}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function seedTenantWithMembers(params: {
  readonly tenantId: string;
  readonly orgId: string;
  readonly handle: string;
  readonly name: string;
  readonly status?: "trial" | "active" | "grace" | "locked" | "suspended";
  readonly ownerUserId: string;
  readonly adminUserId?: string;
  readonly editorUserId?: string;
  readonly businessCategory?: string;
  readonly privacyContact?: string | null;
  readonly whatsappE164?: string | null;
  readonly nowMs: number;
}): Promise<D1Database> {
  const status = params.status ?? "active";
  await env.PLATFORM_DB.batch([
    env.PLATFORM_DB.prepare(
      `INSERT OR REPLACE INTO organizations (id, name, slug, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(params.orgId, params.name, params.handle, params.nowMs, params.nowMs),
    env.PLATFORM_DB.prepare(
      `INSERT OR REPLACE INTO tenants (
         id, organization_id, handle, name, vertical, status, operator_hold,
         paid_through, cache_version, schema_version, version, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'compro', ?, 0, ?, 1, 1, 1, ?, ?)`,
    ).bind(
      params.tenantId,
      params.orgId,
      params.handle,
      params.name,
      status,
      params.nowMs + 30 * DAY_MS,
      params.nowMs,
      params.nowMs,
    ),
    env.PLATFORM_DB.prepare(
      `INSERT OR REPLACE INTO members (id, organization_id, user_id, role, created_at)
       VALUES (?, ?, ?, 'owner', ?)`,
    ).bind(`mem_owner_${params.tenantId}`, params.orgId, params.ownerUserId, params.nowMs),
    ...(params.adminUserId
      ? [
          env.PLATFORM_DB.prepare(
            `INSERT OR REPLACE INTO members (id, organization_id, user_id, role, created_at)
             VALUES (?, ?, ?, 'admin', ?)`,
          ).bind(`mem_admin_${params.tenantId}`, params.orgId, params.adminUserId, params.nowMs),
        ]
      : []),
    ...(params.editorUserId
      ? [
          env.PLATFORM_DB.prepare(
            `INSERT OR REPLACE INTO members (id, organization_id, user_id, role, created_at)
             VALUES (?, ?, ?, 'editor', ?)`,
          ).bind(`mem_editor_${params.tenantId}`, params.orgId, params.editorUserId, params.nowMs),
        ]
      : []),
  ]);

  const publishedExtJson = params.privacyContact
    ? JSON.stringify({
        legalName: null,
        privacyContact: params.privacyContact,
        personRoleTitle: null,
        affiliatedOrgName: null,
        closedDays: [],
        credentials: {},
      })
    : null;

  const tenantDb = await openMigratedTenantDb(params.tenantId);
  await tenantDb.batch([
    tenantDb
      .prepare(
        `INSERT OR REPLACE INTO business_profile (
           id, business_name, business_category, whatsapp_e164, version, updated_at
         ) VALUES (1, ?, ?, ?, 1, ?)`,
      )
      .bind(
        params.name,
        params.businessCategory ?? "b2b_corporate",
        params.whatsappE164 ?? "6281122334455",
        params.nowMs,
      ),
    tenantDb
      .prepare(
        `INSERT OR REPLACE INTO business_profile_structured (
           id, legal_name, privacy_contact, person_role_title, affiliated_org_name,
           closed_days_json, credentials_json, draft_json, published_json, version, updated_at
         ) VALUES (1, NULL, ?, NULL, NULL, '[]', '{}', ?, ?, 1, ?)`,
      )
      .bind(params.privacyContact ?? null, publishedExtJson, publishedExtJson, params.nowMs),
  ]);

  return tenantDb;
}

describe("TASK-080 Workerd Integration: Custom Forms, Compliance, Snapshots, WhatsApp & Security", () => {
  it("enforces 10-form cap, 12-field cap, privacy_contact publish gate, health UU PDP warning, RBAC, and optimistic concurrency", async () => {
    await ensurePlatformMigrated();
    const nowMs = Date.now();
    const suffix = `${nowMs}`;

    const owner = await createSignedInUser(`owner-t080-${suffix}@example.com`, "Owner T080");
    const editor = await createSignedInUser(`editor-t080-${suffix}@example.com`, "Editor T080");
    const outsider = await createSignedInUser(`outsider-t080-${suffix}@example.com`, "Outsider T080");

    const tenantId = `ten_t080_cap_${suffix}`;
    const tenantDb = await seedTenantWithMembers({
      tenantId,
      orgId: `org_t080_cap_${suffix}`,
      handle: `klinik-${suffix.slice(-6)}`,
      name: "Klinik Sehat Nusantara",
      ownerUserId: owner.userId,
      editorUserId: editor.userId,
      businessCategory: "medical_clinic",
      privacyContact: null, // Empty initially -> MUST block publish!
      nowMs,
    });

    const rtEnv = makeRuntimeEnv();

    // 1. Templates endpoint returns 6 templates for owner, 403 for editor, 404 for outsider
    const tplRes = await handleTenantFormTemplatesRequest(
      tenantId,
      makeAdminRequest(`/api/tenants/${tenantId}/forms/templates`, "GET", owner.cookie),
      rtEnv,
    );
    expect(tplRes.status).toBe(200);
    const tplBody = (await tplRes.json()) as { templates: readonly unknown[] };
    expect(tplBody.templates).toHaveLength(6);

    const editorDenied = await handleTenantFormsCollectionRequest(
      tenantId,
      makeAdminRequest(`/api/tenants/${tenantId}/forms`, "GET", editor.cookie),
      rtEnv,
    );
    expect(editorDenied.status).toBe(403);

    const crossTenantDenied = await handleTenantFormsCollectionRequest(
      tenantId,
      makeAdminRequest(`/api/tenants/${tenantId}/forms`, "GET", outsider.cookie),
      rtEnv,
    );
    expect(crossTenantDenied.status).toBe(404);

    // 2. List shows health UU PDP warning and privacyContactConfigured = false
    const listRes = await handleTenantFormsCollectionRequest(
      tenantId,
      makeAdminRequest(`/api/tenants/${tenantId}/forms`, "GET", owner.cookie),
      rtEnv,
    );
    expect(listRes.status).toBe(200);
    const listJson = (await listRes.json()) as {
      compliance: {
        privacyContactConfigured: boolean;
        isHealthCategory: boolean;
        healthWarningMessage: string | null;
      };
    };
    expect(listJson.compliance.privacyContactConfigured).toBe(false);
    expect(listJson.compliance.isHealthCategory).toBe(true);
    expect(listJson.compliance.healthWarningMessage).toContain("UU PDP");

    // 3. Create 1st form from vertical template `booking_layanan`
    const create1 = await handleTenantFormsCollectionRequest(
      tenantId,
      makeAdminRequest(`/api/tenants/${tenantId}/forms`, "POST", owner.cookie, {
        templateKey: "booking_layanan",
        slug: "form-01",
      }),
      rtEnv,
    );
    expect(create1.status).toBe(201);
    const created1 = (await create1.json()) as { form: { id: number; version: number } };

    // 4. Publishing without privacy_contact MUST fail with 422 PRIVACY_CONTACT_REQUIRED!
    const pubBlocked = await handleTenantFormPublishRequest(
      tenantId,
      String(created1.form.id),
      makeAdminRequest(`/api/tenants/${tenantId}/forms/${created1.form.id}/publish`, "POST", owner.cookie, {
        expectedVersion: created1.form.version,
      }),
      rtEnv,
    );
    expect(pubBlocked.status).toBe(422);
    const pubBlockedJson = (await pubBlocked.json()) as {
      error: { fields?: { code: string }[] };
    };
    expect(pubBlockedJson.error.fields?.some((f) => f.code === "PRIVACY_CONTACT_REQUIRED")).toBe(
      true,
    );

    // 4b (Finding 3 regression): draft-only privacy_contact (published_json IS NULL) MUST STILL FAIL publish!
    await tenantDb
      .prepare(
        `UPDATE business_profile_structured
         SET privacy_contact = ?,
             draft_json = ?,
             published_json = NULL
         WHERE id = 1`,
      )
      .bind(
        "draft-only@kliniksehat.co.id",
        JSON.stringify({ privacyContact: "draft-only@kliniksehat.co.id" }),
      )
      .run();

    const pubBlockedDraftOnly = await handleTenantFormPublishRequest(
      tenantId,
      String(created1.form.id),
      makeAdminRequest(`/api/tenants/${tenantId}/forms/${created1.form.id}/publish`, "POST", owner.cookie, {
        expectedVersion: created1.form.version,
      }),
      rtEnv,
    );
    expect(pubBlockedDraftOnly.status).toBe(422);

    // 5. Publish privacy_contact (`published_json`) -> publish now succeeds!
    await tenantDb
      .prepare(
        `UPDATE business_profile_structured
         SET privacy_contact = ?,
             published_json = ?
         WHERE id = 1`,
      )
      .bind(
        "privasi@kliniksehat.co.id",
        JSON.stringify({
          legalName: null,
          privacyContact: "privasi@kliniksehat.co.id",
          personRoleTitle: null,
          affiliatedOrgName: null,
          closedDays: [],
          credentials: {},
        }),
      )
      .run();

    const pubOk = await handleTenantFormPublishRequest(
      tenantId,
      String(created1.form.id),
      makeAdminRequest(`/api/tenants/${tenantId}/forms/${created1.form.id}/publish`, "POST", owner.cookie, {
        expectedVersion: created1.form.version,
      }),
      rtEnv,
    );
    expect(pubOk.status).toBe(200);
    const pubOkJson = (await pubOk.json()) as {
      form: { version: number; publishedVersion: number; isPublished: boolean };
    };
    expect(pubOkJson.form.isPublished).toBe(true);
    expect(pubOkJson.form.publishedVersion).toBe(1);

    // 6. Optimistic concurrency: stale version returns 409 STALE_VERSION
    const staleUpdate = await handleTenantFormDetailRequest(
      tenantId,
      String(created1.form.id),
      makeAdminRequest(`/api/tenants/${tenantId}/forms/${created1.form.id}`, "PUT", owner.cookie, {
        expectedVersion: 1, // stale, current is 2!
        slug: "form-01",
        name: "Renamed Stale",
        fields: [{ key: "nama", type: "short_text", label: "Nama", required: true }],
        afterSubmitAction: "text",
        afterSubmitConfig: { message: "OK" },
      }),
      rtEnv,
    );
    expect(staleUpdate.status).toBe(409);

    // 7. 13th field fails with 422
    const thirteenRes = await handleTenantFormsCollectionRequest(
      tenantId,
      makeAdminRequest(`/api/tenants/${tenantId}/forms`, "POST", owner.cookie, {
        slug: "form-13-fields",
        name: "13 Fields",
        fields: Array.from({ length: 13 }, (_, i) => ({
          key: `f_${i + 1}`,
          type: "short_text",
          label: `Field ${i + 1}`,
          required: false,
        })),
        afterSubmitAction: "text",
        afterSubmitConfig: { message: "OK" },
      }),
      rtEnv,
    );
    expect(thirteenRes.status).toBe(422);

    // 8. Create forms 2..10 -> all succeed; 11th form MUST fail with 422 FORM_LIMIT_EXCEEDED!
    for (let i = 2; i <= 10; i += 1) {
      const res = await handleTenantFormsCollectionRequest(
        tenantId,
        makeAdminRequest(`/api/tenants/${tenantId}/forms`, "POST", owner.cookie, {
          templateKey: "kontak_umum",
          slug: `form-${String(i).padStart(2, "0")}`,
          name: `Formulir #${i}`,
        }),
        rtEnv,
      );
      expect(res.status, `Form #${i} should succeed`).toBe(201);
    }

    const eleventhRes = await handleTenantFormsCollectionRequest(
      tenantId,
      makeAdminRequest(`/api/tenants/${tenantId}/forms`, "POST", owner.cookie, {
        templateKey: "kontak_umum",
        slug: "form-11",
        name: "Formulir Ke-11",
      }),
      rtEnv,
    );
    expect(eleventhRes.status).toBe(422);
    const eleventhJson = (await eleventhRes.json()) as {
      error: { fields?: { code: string }[] };
    };
    expect(eleventhJson.error.fields?.some((f) => f.code === "FORM_LIMIT_EXCEEDED")).toBe(true);

    // 9. Locked tenant (H+5 overdue window) can GET (200) but mutations fail with 403 SUBSCRIPTION_LOCKED
    await env.PLATFORM_DB.prepare(
      "UPDATE tenants SET status = 'locked', paid_through = ? WHERE id = ?",
    )
      .bind(nowMs - 5 * DAY_MS, tenantId)
      .run();

    const lockedGet = await handleTenantFormsCollectionRequest(
      tenantId,
      makeAdminRequest(`/api/tenants/${tenantId}/forms`, "GET", owner.cookie),
      rtEnv,
    );
    expect(lockedGet.status).toBe(200);

    const lockedPost = await handleTenantFormsCollectionRequest(
      tenantId,
      makeAdminRequest(`/api/tenants/${tenantId}/forms`, "POST", owner.cookie, {
        templateKey: "kontak_umum",
        slug: "form-locked",
      }),
      rtEnv,
    );
    expect(lockedPost.status).toBe(403);
  });

  it("handles custom form submissions, 1-level conditional required fields, immutable lead snapshots after form edits, WhatsApp after-submit, No-JS PRG, Turnstile, honeypot & rate limit", async () => {
    await ensurePlatformMigrated();
    const nowMs = Date.now();
    const suffix = `sub_${nowMs}`;

    const owner = await createSignedInUser(`owner-sub-${suffix}@example.com`, "Owner Sub");
    const tenantId = `ten_t080_${suffix}`;
    const handle = `rfq-${String(nowMs).slice(-6)}`;
    const tenantHost = `${handle}.situsku.click`;

    const tenantDb = await seedTenantWithMembers({
      tenantId,
      orgId: `org_t080_${suffix}`,
      handle,
      name: "PT Karya Baja Mandiri",
      ownerUserId: owner.userId,
      businessCategory: "b2b_corporate",
      privacyContact: "privasi@karyabaja.co.id",
      whatsappE164: "6281299001122",
      nowMs,
    });

    const rtEnv = makeRuntimeEnv();
    const mailSink = createLocalMailSink();

    // 1. Create & publish `permintaan_penawaran` form
    const createRes = await handleTenantFormsCollectionRequest(
      tenantId,
      makeAdminRequest(`/api/tenants/${tenantId}/forms`, "POST", owner.cookie, {
        templateKey: "permintaan_penawaran",
        slug: "rfq-b2b",
      }),
      rtEnv,
    );
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { form: { id: number; version: number } };

    // Submitting to unpublished draft MUST fail with 404
    const draftSubmit = await handlePublicLeadPost(
      new Request(`https://${tenantHost}/api/leads`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: `https://${tenantHost}`,
          "CF-Connecting-IP": "198.51.100.10",
        },
        body: JSON.stringify({
          formSlug: "rfq-b2b",
          answers: { nama_pic: "Test" },
        }),
      }),
      {
        surface: "tenant",
        tenant: { id: tenantId, handle, name: "PT Karya Baja Mandiri", host: tenantHost, status: "active" },
        tenantDb,
        platformDb: env.PLATFORM_DB,
        emailPort: mailSink,
        ownerEmail: `owner-sub-${suffix}@example.com`,
        appEnv: "test",
        rateLimitSalt: TEST_RATE_LIMIT_SALT,
        nowMs,
      },
    );
    expect(draftSubmit.status).toBe(404);

    // Publish v1
    const pubRes = await handleTenantFormPublishRequest(
      tenantId,
      String(created.form.id),
      makeAdminRequest(`/api/tenants/${tenantId}/forms/${created.form.id}/publish`, "POST", owner.cookie, {
        expectedVersion: created.form.version,
      }),
      rtEnv,
    );
    expect(pubRes.status).toBe(200);
    const pubBody = (await pubRes.json()) as { form: { version: number; publishedVersion: number } };

    // 2. Conditional required field missing when triggered (`perlu_survei = "Ya"` without `lokasi_survei`) -> 422
    const condFailRes = await handlePublicLeadPost(
      new Request(`https://${tenantHost}/api/leads`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: `https://${tenantHost}`,
          "CF-Connecting-IP": "198.51.100.11",
        },
        body: JSON.stringify({
          formSlug: "rfq-b2b",
          privacyConsent: true,
          answers: {
            nama_pic: "Siti Rahma",
            nama_perusahaan: "CV Logam Jaya",
            no_whatsapp: "081234567890",
            kategori_kebutuhan: "Jasa Proyek / Kontraktor",
            perlu_survei: "Ya",
            rincian_kebutuhan: "Konstruksi baja 20 ton",
            persetujuan_privasi: true,
          },
        }),
      }),
      {
        surface: "tenant",
        tenant: { id: tenantId, handle, name: "PT Karya Baja Mandiri", host: tenantHost, status: "active" },
        tenantDb,
        platformDb: env.PLATFORM_DB,
        emailPort: mailSink,
        ownerEmail: `owner-sub-${suffix}@example.com`,
        appEnv: "test",
        rateLimitSalt: TEST_RATE_LIMIT_SALT,
        nowMs,
      },
    );
    expect(condFailRes.status).toBe(422);
    const condFailJson = (await condFailRes.json()) as { error: { fields?: { field: string }[] } };
    expect(condFailJson.error.fields?.some((f) => f.field === "lokasi_survei")).toBe(true);

    // 2b (Finding 2 regression): custom consent_checkbox checked WITHOUT mandatory privacyConsent MUST fail 422!
    const noPrivacyConsentRes = await handlePublicLeadPost(
      new Request(`https://${tenantHost}/api/leads`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: `https://${tenantHost}`,
          "CF-Connecting-IP": "198.51.100.21",
        },
        body: JSON.stringify({
          formSlug: "rfq-b2b",
          answers: {
            nama_pic: "Siti Rahma",
            nama_perusahaan: "CV Logam Jaya",
            no_whatsapp: "0812-3456-7890",
            kategori_kebutuhan: "Jasa Proyek / Kontraktor",
            perlu_survei: "Tidak",
            rincian_kebutuhan: "Konstruksi gudang baja 20 ton",
            persetujuan_privasi: true,
          },
        }),
      }),
      {
        surface: "tenant",
        tenant: { id: tenantId, handle, name: "PT Karya Baja Mandiri", host: tenantHost, status: "active" },
        tenantDb,
        platformDb: env.PLATFORM_DB,
        emailPort: mailSink,
        ownerEmail: `owner-sub-${suffix}@example.com`,
        appEnv: "test",
        rateLimitSalt: TEST_RATE_LIMIT_SALT,
        nowMs,
      },
    );
    expect(noPrivacyConsentRes.status).toBe(422);
    const noConsentJson = (await noPrivacyConsentRes.json()) as {
      error: { fields?: { field: string; code: string }[] };
    };
    expect(
      noConsentJson.error.fields?.some(
        (f) => f.field === "privacyConsent" && f.code === "PRIVACY_CONSENT_REQUIRED",
      ),
    ).toBe(true);

    // 3. Valid submission with `lokasi_survei` + mandatory `privacyConsent: true` -> 201 + accurate WhatsApp summary URL!
    const validPayload = {
      formSlug: "rfq-b2b",
      privacyConsent: true,
      answers: {
        nama_pic: "Siti Rahma",
        nama_perusahaan: "CV Logam Jaya",
        no_whatsapp: "0812-3456-7890",
        email_kantor: "siti@logamjaya.co.id",
        kategori_kebutuhan: "Jasa Proyek / Kontraktor",
        perlu_survei: "Ya",
        lokasi_survei: "Kawasan MM2100 Bekasi",
        rincian_kebutuhan: "Konstruksi gudang baja 20 ton",
        persetujuan_privasi: true,
      },
      sourcePath: "/penawaran",
    };

    const okRes = await handlePublicLeadPost(
      new Request(`https://${tenantHost}/api/leads`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: `https://${tenantHost}`,
          "CF-Connecting-IP": "198.51.100.12",
          "Idempotency-Key": "rfq-idem-001",
        },
        body: JSON.stringify(validPayload),
      }),
      {
        surface: "tenant",
        tenant: { id: tenantId, handle, name: "PT Karya Baja Mandiri", host: tenantHost, status: "active" },
        tenantDb,
        platformDb: env.PLATFORM_DB,
        emailPort: mailSink,
        ownerEmail: `owner-sub-${suffix}@example.com`,
        appEnv: "test",
        rateLimitSalt: TEST_RATE_LIMIT_SALT,
        nowMs,
      },
    );
    expect(okRes.status).toBe(201);
    const okJson = (await okRes.json()) as {
      leadNumber: number;
      formSlug: string;
      formVersion: number;
      afterSubmit: { action: string; whatsappUrl: string | null };
    };
    expect(okJson.leadNumber).toBe(1);
    expect(okJson.formSlug).toBe("rfq-b2b");
    expect(okJson.formVersion).toBe(1);
    expect(okJson.afterSubmit.action).toBe("whatsapp");
    expect(okJson.afterSubmit.whatsappUrl).toMatch(/^https:\/\/wa\.me\/6281299001122\?text=/);
    const decodedWa = decodeURIComponent(okJson.afterSubmit.whatsappUrl!.split("?text=")[1]!);
    expect(decodedWa).toContain("Nama PIC: Siti Rahma");
    expect(decodedWa).toContain("Kota / Alamat Lokasi Survei: Kawasan MM2100 Bekasi");

    // PII-free owner notification email sent ONCE
    expect(mailSink.list()).toHaveLength(1);
    const sentMail = mailSink.list()[0]!;
    expect(sentMail.html).not.toContain("Siti Rahma");
    expect(sentMail.html).not.toContain("081234567890");
    expect(sentMail.html).not.toContain("MM2100");
    expect(sentMail.text).not.toContain("Siti Rahma");

    // Idempotent replay returns same leadNumber WITHOUT duplicate email
    const replayRes = await handlePublicLeadPost(
      new Request(`https://${tenantHost}/api/leads`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: `https://${tenantHost}`,
          "CF-Connecting-IP": "198.51.100.12",
          "Idempotency-Key": "rfq-idem-001",
        },
        body: JSON.stringify(validPayload),
      }),
      {
        surface: "tenant",
        tenant: { id: tenantId, handle, name: "PT Karya Baja Mandiri", host: tenantHost, status: "active" },
        tenantDb,
        platformDb: env.PLATFORM_DB,
        emailPort: mailSink,
        ownerEmail: `owner-sub-${suffix}@example.com`,
        appEnv: "test",
        rateLimitSalt: TEST_RATE_LIMIT_SALT,
        nowMs,
      },
    );
    expect(replayRes.status).toBe(201);
    expect(mailSink.list()).toHaveLength(1);

    // 4. Edit form field labels AND draft slug ("rfq-b2b-draft") BEFORE republishing:
    //    Finding 1b regression: live slug "rfq-b2b" MUST stay active and "rfq-b2b-draft" MUST stay 404 until publish!
    const tpl = getFormVerticalTemplate("permintaan_penawaran")!;
    const renamedFields = tpl.fields.map((f) =>
      f.key === "nama_pic" ? { ...f, label: "Nama Kontak Baru (v2)" } : f,
    );
    const editRes = await handleTenantFormDetailRequest(
      tenantId,
      String(created.form.id),
      makeAdminRequest(`/api/tenants/${tenantId}/forms/${created.form.id}`, "PUT", owner.cookie, {
        expectedVersion: pubBody.form.version,
        slug: "rfq-b2b-draft",
        name: "Permintaan Penawaran v2",
        fields: renamedFields,
        afterSubmitAction: "whatsapp",
        afterSubmitConfig: tpl.afterSubmitConfig,
      }),
      rtEnv,
    );
    expect(editRes.status).toBe(200);
    const edited = (await editRes.json()) as { form: { version: number } };

    // Unpublished renamed slug MUST 404 while old live slug "rfq-b2b" STILL works!
    const renamedSlugBeforePub = await handlePublicLeadPost(
      new Request(`https://${tenantHost}/api/leads`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: `https://${tenantHost}`,
          "CF-Connecting-IP": "198.51.100.31",
        },
        body: JSON.stringify({ ...validPayload, formSlug: "rfq-b2b-draft" }),
      }),
      {
        surface: "tenant",
        tenant: { id: tenantId, handle, name: "PT Karya Baja Mandiri", host: tenantHost, status: "active" },
        tenantDb,
        appEnv: "test",
        rateLimitSalt: TEST_RATE_LIMIT_SALT,
        nowMs,
      },
    );
    expect(renamedSlugBeforePub.status).toBe(404);

    // Round-2 regression: Form B created with the freed draft slug "rfq-b2b" MUST get 409 CONFLICT
    // when attempting to publish because Form A is still the active live published form on "rfq-b2b"!
    const formBCreate = await handleTenantFormsCollectionRequest(
      tenantId,
      makeAdminRequest(`/api/tenants/${tenantId}/forms`, "POST", owner.cookie, {
        templateKey: "kontak_umum",
        slug: "rfq-b2b",
        name: "Form B Hijack Attempt",
      }),
      rtEnv,
    );
    expect(formBCreate.status).toBe(201);
    const formB = (await formBCreate.json()) as { form: { id: number; version: number } };

    const formBPubConflict = await handleTenantFormPublishRequest(
      tenantId,
      String(formB.form.id),
      makeAdminRequest(`/api/tenants/${tenantId}/forms/${formB.form.id}/publish`, "POST", owner.cookie, {
        expectedVersion: formB.form.version,
      }),
      rtEnv,
    );
    expect(formBPubConflict.status).toBe(409);
    const formBConflictJson = (await formBPubConflict.json()) as {
      error: { code: string; fields?: { code: string }[] };
    };
    expect(formBConflictJson.error.code).toBe("CONFLICT");
    expect(formBConflictJson.error.fields?.some((f) => f.code === "SLUG_CONFLICT")).toBe(true);

    // Verify Form A remains the sole active published form on "rfq-b2b"
    const activeOnSlug = await tenantDb
      .prepare(
        `SELECT id FROM tenant_forms
         WHERE active = 1
           AND published_definition_json IS NOT NULL
           AND json_extract(published_definition_json, '$.slug') = 'rfq-b2b'`,
      )
      .all<{ id: number }>();
    expect(activeOnSlug.results?.map((r) => Number(r.id))).toEqual([created.form.id]);

    // Clean up unused Form B so Form A can rename its draft slug back to "rfq-b2b"
    const delFormB = await handleTenantFormDetailRequest(
      tenantId,
      String(formB.form.id),
      makeAdminRequest(
        `/api/tenants/${tenantId}/forms/${formB.form.id}?expectedVersion=${formB.form.version}`,
        "DELETE",
        owner.cookie,
      ),
      rtEnv,
    );
    expect(delFormB.status).toBe(200);

    // Rename draft slug back to "rfq-b2b" & republish v2 -> historical lead #1 snapshot MUST remain 100% intact!
    const editBackRes = await handleTenantFormDetailRequest(
      tenantId,
      String(created.form.id),
      makeAdminRequest(`/api/tenants/${tenantId}/forms/${created.form.id}`, "PUT", owner.cookie, {
        expectedVersion: edited.form.version,
        slug: "rfq-b2b",
        name: "Permintaan Penawaran v2",
        fields: renamedFields,
        afterSubmitAction: "whatsapp",
        afterSubmitConfig: tpl.afterSubmitConfig,
      }),
      rtEnv,
    );
    expect(editBackRes.status).toBe(200);
    const editedBack = (await editBackRes.json()) as { form: { version: number } };

    const repubRes = await handleTenantFormPublishRequest(
      tenantId,
      String(created.form.id),
      makeAdminRequest(`/api/tenants/${tenantId}/forms/${created.form.id}/publish`, "POST", owner.cookie, {
        expectedVersion: editedBack.form.version,
      }),
      rtEnv,
    );
    expect(repubRes.status).toBe(200);
    const repubBody = (await repubRes.json()) as { form: { version: number } };

    const historical = await getLeadFormSnapshotById(tenantDb, okJson.leadNumber);
    expect(historical?.snapshot?.formName).toBe("Permintaan Penawaran Harga (RFQ)");
    expect(historical?.snapshot?.publishedVersion).toBe(1);
    const histPic = historical?.snapshot?.answers.find((a) => a.key === "nama_pic");
    expect(histPic?.label).toBe("Nama PIC"); // Unchanged!
    expect(histPic?.type).toBe("short_text");
    expect(histPic?.value).toBe("Siti Rahma");

    // 5. Deleting a form with leads MUST fail with 409 CONFLICT
    const delWithLeads = await handleTenantFormDetailRequest(
      tenantId,
      String(created.form.id),
      makeAdminRequest(
        `/api/tenants/${tenantId}/forms/${created.form.id}?expectedVersion=${repubBody.form.version}`,
        "DELETE",
        owner.cookie,
      ),
      rtEnv,
    );
    expect(delWithLeads.status).toBe(409);

    // 5b (Finding 1a regression): Unpublishing a form and then calling PUT with `active: true` MUST NOT reactivate it!
    const unpubRes = await handleTenantFormPublishRequest(
      tenantId,
      String(created.form.id),
      makeAdminRequest(`/api/tenants/${tenantId}/forms/${created.form.id}/publish`, "POST", owner.cookie, {
        expectedVersion: repubBody.form.version,
        action: "unpublish",
      }),
      rtEnv,
    );
    expect(unpubRes.status).toBe(200);
    const unpubBody = (await unpubRes.json()) as { form: { version: number; active: boolean; isPublished: boolean } };
    expect(unpubBody.form.active).toBe(false);
    expect(unpubBody.form.isPublished).toBe(false);

    const tryReactivateViaPut = await handleTenantFormDetailRequest(
      tenantId,
      String(created.form.id),
      makeAdminRequest(`/api/tenants/${tenantId}/forms/${created.form.id}`, "PUT", owner.cookie, {
        expectedVersion: unpubBody.form.version,
        slug: "rfq-b2b",
        name: "Attempted Reactivation Via PUT",
        fields: renamedFields,
        afterSubmitAction: "whatsapp",
        afterSubmitConfig: tpl.afterSubmitConfig,
        active: true,
      }),
      rtEnv,
    );
    expect(tryReactivateViaPut.status).toBe(200);
    const afterPutUnpub = (await tryReactivateViaPut.json()) as {
      form: { version: number; active: boolean; isPublished: boolean };
    };
    expect(afterPutUnpub.form.active).toBe(false);
    expect(afterPutUnpub.form.isPublished).toBe(false);

    // Public POST MUST still return 404 while unpublished!
    const submitWhileUnpub = await handlePublicLeadPost(
      new Request(`https://${tenantHost}/api/leads`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: `https://${tenantHost}`,
          "CF-Connecting-IP": "198.51.100.32",
        },
        body: JSON.stringify(validPayload),
      }),
      {
        surface: "tenant",
        tenant: { id: tenantId, handle, name: "PT Karya Baja Mandiri", host: tenantHost, status: "active" },
        tenantDb,
        appEnv: "test",
        rateLimitSalt: TEST_RATE_LIMIT_SALT,
        nowMs,
      },
    );
    expect(submitWhileUnpub.status).toBe(404);

    // Explicitly re-publish so subsequent No-JS & security checks run against active v3 form
    const repubAgain = await handleTenantFormPublishRequest(
      tenantId,
      String(created.form.id),
      makeAdminRequest(`/api/tenants/${tenantId}/forms/${created.form.id}/publish`, "POST", owner.cookie, {
        expectedVersion: afterPutUnpub.form.version,
        action: "publish",
      }),
      rtEnv,
    );
    expect(repubAgain.status).toBe(200);

    // 6. No-JS application/x-www-form-urlencoded submission -> 303 redirect to https://wa.me/...
    const noJsBody = new URLSearchParams({
      formSlug: "rfq-b2b",
      privacyConsent: "true",
      sourcePath: "/penawaran",
      returnTo: "/penawaran",
      cf_nama_pic: "Bambang Sudiro",
      cf_nama_perusahaan: "PT Baja Prima",
      cf_no_whatsapp: "081344556677",
      cf_kategori_kebutuhan: "Maklon / OEM",
      cf_perlu_survei: "Tidak",
      cf_rincian_kebutuhan: "Order batch pertama",
      cf_persetujuan_privasi: "true",
    }).toString();

    const noJsRes = await handlePublicLeadPost(
      new Request(`https://${tenantHost}/api/leads`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Sec-Fetch-Site": "same-origin",
          "CF-Connecting-IP": "198.51.100.13",
        },
        body: noJsBody,
      }),
      {
        surface: "tenant",
        tenant: { id: tenantId, handle, name: "PT Karya Baja Mandiri", host: tenantHost, status: "active" },
        tenantDb,
        platformDb: env.PLATFORM_DB,
        emailPort: mailSink,
        ownerEmail: `owner-sub-${suffix}@example.com`,
        appEnv: "test",
        rateLimitSalt: TEST_RATE_LIMIT_SALT,
        nowMs,
      },
    );
    expect(noJsRes.status).toBe(303);
    const noJsLoc = noJsRes.headers.get("location") ?? "";
    expect(noJsLoc.startsWith("https://wa.me/6281299001122?text=")).toBe(true);
    expect(decodeURIComponent(noJsLoc.split("?text=")[1]!)).toContain(
      "Nama Kontak Baru (v2): Bambang Sudiro",
    );

    // 7. Turnstile required when enforced, honeypot silent drop, and rate limit (429) hold!
    const turnstileBlocked = await handlePublicLeadPost(
      new Request(`https://${tenantHost}/api/leads`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: `https://${tenantHost}`,
          "CF-Connecting-IP": "198.51.100.14",
        },
        body: JSON.stringify(validPayload),
      }),
      {
        surface: "tenant",
        tenant: { id: tenantId, handle, name: "PT Karya Baja Mandiri", host: tenantHost, status: "active" },
        tenantDb,
        appEnv: "production",
        turnstileSecretKey: "test-secret",
        rateLimitSalt: TEST_RATE_LIMIT_SALT,
        nowMs,
      },
    );
    expect(turnstileBlocked.status).toBe(403);

    // Honeypot silent drop -> 201 leadNumber 0, no DB write
    const beforeHpCount = await tenantDb
      .prepare("SELECT COUNT(*) AS cnt FROM leads")
      .first<{ cnt: number }>();
    const hpRes = await handlePublicLeadPost(
      new Request(`https://${tenantHost}/api/leads`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: `https://${tenantHost}`,
          "CF-Connecting-IP": "198.51.100.15",
        },
        body: JSON.stringify({ ...validPayload, hp_website: "https://spam.example" }),
      }),
      {
        surface: "tenant",
        tenant: { id: tenantId, handle, name: "PT Karya Baja Mandiri", host: tenantHost, status: "active" },
        tenantDb,
        appEnv: "test",
        rateLimitSalt: TEST_RATE_LIMIT_SALT,
        nowMs,
      },
    );
    expect(hpRes.status).toBe(201);
    const afterHpCount = await tenantDb
      .prepare("SELECT COUNT(*) AS cnt FROM leads")
      .first<{ cnt: number }>();
    expect(afterHpCount?.cnt).toBe(beforeHpCount?.cnt);

    // Rate limit enforcement -> 429 RATE_LIMITED
    const rlPolicy = {
      perNetworkMinute: { name: "lead_network_minute", limit: 1, windowMs: 60_000 },
      perTenantHour: { name: "lead_tenant_hour", limit: 100, windowMs: 3_600_000 },
    };
    const rl1 = await handlePublicLeadPost(
      new Request(`https://${tenantHost}/api/leads`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: `https://${tenantHost}`,
          "CF-Connecting-IP": "198.51.100.99",
        },
        body: JSON.stringify({ ...validPayload, answers: { ...validPayload.answers, perlu_survei: "Tidak" } }),
      }),
      {
        surface: "tenant",
        tenant: { id: tenantId, handle, name: "PT Karya Baja Mandiri", host: tenantHost, status: "active" },
        tenantDb,
        appEnv: "test",
        rateLimitSalt: TEST_RATE_LIMIT_SALT,
        rateLimitPolicy: rlPolicy,
        nowMs,
      },
    );
    expect(rl1.status).toBe(201);

    const rl2 = await handlePublicLeadPost(
      new Request(`https://${tenantHost}/api/leads`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: `https://${tenantHost}`,
          "CF-Connecting-IP": "198.51.100.99",
        },
        body: JSON.stringify(validPayload),
      }),
      {
        surface: "tenant",
        tenant: { id: tenantId, handle, name: "PT Karya Baja Mandiri", host: tenantHost, status: "active" },
        tenantDb,
        appEnv: "test",
        rateLimitSalt: TEST_RATE_LIMIT_SALT,
        rateLimitPolicy: rlPolicy,
        nowMs,
      },
    );
    expect(rl2.status).toBe(429);
  });
});

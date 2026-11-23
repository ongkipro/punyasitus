import { env } from "cloudflare:workers";
import {
  applySessionTwoFactorMigration,
  createAuth,
  createTwoFactorEnrolledOperatorFixture,
  mergeCookieHeaders,
  type ConsoleRuntimeEnv,
} from "@punyasitus/auth";
import { ensureAgencyPortalSchema } from "@punyasitus/db/agencies/index";
import { applyPlatformMigrations } from "@punyasitus/db/connections";
import {
  ensurePlatformOperatorRolesSchema,
  listPlatformAuditEntries,
  PLATFORM_MIGRATIONS,
} from "@punyasitus/db/platform";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadDashboardSupportContext } from "../../apps/web/src/components/admin/help/support-loader.ts";
import { handleConsoleSettingsRequest } from "../../apps/web/src/pages/api/console/settings/index.ts";

const CONSOLE_ORIGIN = "https://console.punyasitus.com";
const APP_ORIGIN = "https://app.punyasitus.com";
const APP_SECRET = "task105-app-auth-secret-0123456789abcdef0123456789abcdef";
const CONSOLE_SECRET = "task105-console-auth-secret-fedcba9876543210fedcba987654";

function buildConsoleEnv(): ConsoleRuntimeEnv {
  return {
    APP_ENV: "test",
    PLATFORM_DOMAIN: "punyasitus.com",
    PLATFORM_DB: env.PLATFORM_DB,
    AUTH_SECRET: APP_SECRET,
    CONSOLE_AUTH_SECRET: CONSOLE_SECRET,
  };
}

function createConsoleAuth() {
  return createAuth(env.PLATFORM_DB, {
    baseURL: CONSOLE_ORIGIN,
    secret: CONSOLE_SECRET,
    surface: "console",
    trustedOrigins: [CONSOLE_ORIGIN],
  });
}

async function resetTables(): Promise<void> {
  await env.PLATFORM_DB.batch([
    env.PLATFORM_DB.prepare("DELETE FROM agency_client_links"),
    env.PLATFORM_DB.prepare("DELETE FROM agency_enrollment_records"),
    env.PLATFORM_DB.prepare("DELETE FROM agency_members"),
    env.PLATFORM_DB.prepare("DELETE FROM agency_invitations"),
    env.PLATFORM_DB.prepare("DELETE FROM session_two_factor_verifications"),
    env.PLATFORM_DB.prepare("DELETE FROM two_factors"),
    env.PLATFORM_DB.prepare("DELETE FROM platform_operators"),
    env.PLATFORM_DB.prepare("DELETE FROM platform_settings"),
    env.PLATFORM_DB.prepare("DELETE FROM tenant_hosts"),
    env.PLATFORM_DB.prepare("DELETE FROM tenants"),
    env.PLATFORM_DB.prepare("DELETE FROM agencies"),
    env.PLATFORM_DB.prepare("DELETE FROM members"),
    env.PLATFORM_DB.prepare("DELETE FROM organizations"),
    env.PLATFORM_DB.prepare("DELETE FROM accounts"),
    env.PLATFORM_DB.prepare("DELETE FROM sessions"),
    env.PLATFORM_DB.prepare("DELETE FROM verifications"),
    env.PLATFORM_DB.prepare("DELETE FROM users"),
  ]);
}

describe("TASK-105 workerd integration — console support settings persistence, audit & agency-first lookup", () => {
  beforeAll(async () => {
    await applyPlatformMigrations(env.PLATFORM_DB, PLATFORM_MIGRATIONS);
    await applySessionTwoFactorMigration(env.PLATFORM_DB);
    await ensurePlatformOperatorRolesSchema(env.PLATFORM_DB);
    await ensureAgencyPortalSchema(env.PLATFORM_DB);
  });

  beforeEach(async () => {
    await resetTables();
  });

  it("persists support WhatsApp, published hours & response target via console API with 2FA/CSRF + platform_audit, and loads live values on dashboard", async () => {
    const runtimeEnv = buildConsoleEnv();
    const auth = createConsoleAuth();
    const nowMs = Date.now();

    const op = await createTwoFactorEnrolledOperatorFixture(env.PLATFORM_DB, {
      auth,
      email: "t105-op@example.com",
      password: "OperatorPassword!234",
      name: "Support Settings Operator",
      nowMs,
    });

    // 1. CSRF rejection without Origin
    const csrfBlocked = await handleConsoleSettingsRequest(
      new Request(`${CONSOLE_ORIGIN}/api/console/settings`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://evil.example",
          cookie: op.cookieHeader,
        },
        body: JSON.stringify({}),
      }),
      runtimeEnv,
      { nowMs: nowMs + 1000 },
    );
    expect(csrfBlocked.status).toBe(403);

    // 2. Host boundary enforcement (404 on app host)
    const wrongHost = await handleConsoleSettingsRequest(
      new Request(`${APP_ORIGIN}/api/console/settings`, {
        headers: { cookie: op.cookieHeader },
      }),
      runtimeEnv,
    );
    expect(wrongHost.status).toBe(404);

    // 3. Stale 2FA step-up -> 403 REAUTH_REQUIRED
    const staleReauth = await handleConsoleSettingsRequest(
      new Request(`${CONSOLE_ORIGIN}/api/console/settings`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Origin: CONSOLE_ORIGIN,
          cookie: op.cookieHeader,
        },
        body: JSON.stringify({
          salesWhatsapp: "0812-9876-5432",
          supportEmail: "dukungan@punyasitus.com",
          termsUrl: "https://punyasitus.com/syarat-ketentuan",
          privacyUrl: "https://punyasitus.com/kebijakan-privasi",
          supportHours: "Senin–Jumat 09:00–17:00 WIB, Sabtu 09:00–13:00 WIB",
          supportResponseTarget: "< 2 jam kerja",
          expectedVersion: 0,
          reason: "Memperbarui nomor WA dukungan dan jam layanan resmi",
        }),
      }),
      runtimeEnv,
      { nowMs: nowMs + 15 * 60 * 1000 },
    );
    expect(staleReauth.status).toBe(403);
    expect(((await staleReauth.json()) as { code: string }).code).toBe("REAUTH_REQUIRED");

    // 4. Authorized save with fresh 2FA + Origin + audit reason -> 200 & writes platform_audit
    const saveRes = await handleConsoleSettingsRequest(
      new Request(`${CONSOLE_ORIGIN}/api/console/settings`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Origin: CONSOLE_ORIGIN,
          cookie: op.cookieHeader,
        },
        body: JSON.stringify({
          salesWhatsapp: "0812-9876-5432",
          supportEmail: "dukungan@punyasitus.com",
          termsUrl: "https://punyasitus.com/syarat-ketentuan",
          privacyUrl: "https://punyasitus.com/kebijakan-privasi",
          supportHours: "Senin–Jumat 09:00–17:00 WIB, Sabtu 09:00–13:00 WIB",
          supportResponseTarget: "< 2 jam kerja",
          expectedVersion: 0,
          reason: "Memperbarui nomor WA dukungan dan jam layanan resmi TASK-105",
        }),
      }),
      runtimeEnv,
      { nowMs: nowMs + 2000, requestId: "req_t105_save_1" },
    );
    expect(saveRes.status).toBe(200);

    const saveJson = (await saveRes.json()) as {
      success: boolean;
      auditId: string;
      changedFields: string[];
      settings: {
        salesWhatsapp: string;
        supportHours: string | null;
        supportResponseTarget: string | null;
      };
      supportConfig: {
        whatsappNumber: string | null;
        supportHours: string;
        supportResponseTarget: string;
        whatsappConfigured: boolean;
      };
    };
    expect(saveJson.success).toBe(true);
    expect(saveJson.settings.salesWhatsapp).toBe("6281298765432");
    expect(saveJson.settings.supportHours).toBe(
      "Senin–Jumat 09:00–17:00 WIB, Sabtu 09:00–13:00 WIB",
    );
    expect(saveJson.settings.supportResponseTarget).toBe("< 2 jam kerja");
    expect(saveJson.supportConfig).toMatchObject({
      whatsappNumber: "6281298765432",
      supportHours: "Senin–Jumat 09:00–17:00 WIB, Sabtu 09:00–13:00 WIB",
      supportResponseTarget: "< 2 jam kerja",
      whatsappConfigured: true,
    });
    expect(saveJson.changedFields).toContain("salesWhatsapp");
    expect(saveJson.changedFields).toContain("supportHours");
    expect(saveJson.changedFields).toContain("supportResponseTarget");

    const auditRows = await listPlatformAuditEntries(env.PLATFORM_DB, {
      requestId: "req_t105_save_1",
    });
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.id).toBe(saveJson.auditId);
    expect(auditRows[0]?.action).toBe("platform_settings.update");

    // 5. Seed a standard tenant + an agency-managed client tenant in PLATFORM_DB
    const nonOpSignUp = await auth.api.signUpEmail({
      body: {
        email: "agency-owner@example.com",
        password: "AgencyOwnerPassword!234",
        name: "Pemilik Agensi Nusantara",
      },
      asResponse: true,
    });
    const nonOpCookie = mergeCookieHeaders(null, nonOpSignUp.headers);
    const nonOpSess = await auth.api.getSession({
      headers: new Headers({ cookie: nonOpCookie }),
    });
    const agencyOwnerId = nonOpSess!.user.id;

    await env.PLATFORM_DB.batch([
      env.PLATFORM_DB.prepare(
        `INSERT INTO organizations (id, name, slug, created_at, updated_at)
         VALUES ('org_std_1', 'Kopi Nusantara', 'org-std-1', ?, ?),
                ('org_agn_1', 'Agensi Digital Nusantara', 'org-agn-1', ?, ?),
                ('org_cli_1', 'Klinik Harapan', 'org-cli-1', ?, ?)`,
      ).bind(nowMs, nowMs, nowMs, nowMs, nowMs, nowMs),
      env.PLATFORM_DB.prepare(
        `INSERT INTO agencies (id, organization_id, owner_user_id, name, status, discount_percent, unpaid_trial_cap, version, created_at, updated_at)
         VALUES ('agn_t105_1', 'org_agn_1', ?, 'Agensi Digital Nusantara', 'active', 15, 3, 1, ?, ?)`,
      ).bind(agencyOwnerId, nowMs, nowMs),
      env.PLATFORM_DB.prepare(
        `INSERT INTO agency_enrollment_records (
           agency_id, enrollment_source, terms_version, terms_accepted_at, terms_accepted_by_user_id,
           billing_email, billing_name, discount_tier_code, discount_tiers_json, created_at, updated_at
         )
         VALUES ('agn_t105_1', 'self_registered', '2026-11-agency-v1', ?, ?, 'support@agensinusantara.id', 'Agensi Digital Nusantara', 'standard_0', '[]', ?, ?)`,
      ).bind(nowMs, agencyOwnerId, nowMs, nowMs),
      env.PLATFORM_DB.prepare(
        `INSERT INTO tenants (id, organization_id, handle, name, vertical, status, agency_id, created_at, updated_at)
         VALUES ('tnt_std_1', 'org_std_1', 'kopi-nusantara', 'Kopi Nusantara', 'catalog', 'active', NULL, ?, ?),
                ('tnt_cli_1', 'org_cli_1', 'klinik-harapan', 'Klinik Harapan', 'compro', 'active', 'agn_t105_1', ?, ?)`,
      ).bind(nowMs, nowMs, nowMs, nowMs),
      env.PLATFORM_DB.prepare(
        `INSERT INTO agency_client_links (
           tenant_id, agency_id, billing_payer, provisioned_by_user_id, is_unpaid_trial, created_at, updated_at
         )
         VALUES ('tnt_cli_1', 'agn_t105_1', 'agency', ?, 0, ?, ?)`,
      ).bind(agencyOwnerId, nowMs, nowMs),
    ]);

    // 6. Standard tenant loads platform support settings from PLATFORM_DB
    const stdSupport = await loadDashboardSupportContext(env.PLATFORM_DB, {
      tenantId: "tnt_std_1",
      handle: "kopi-nusantara",
      screen: "settings_domains",
    });
    expect(stdSupport.mode).toBe("platform");
    expect(stdSupport.primaryChannel.kind).toBe("platform");
    expect(stdSupport.primaryChannel.whatsappNumber).toBe("6281298765432");
    expect(stdSupport.primaryChannel.whatsappUrl).toBe(
      `https://wa.me/6281298765432?text=${encodeURIComponent(
        "Halo, saya butuh bantuan untuk situs kopi-nusantara, halaman Domain Kustom & DNS.",
      )}`,
    );
    expect(stdSupport.platformChannel.supportHours).toBe(
      "Senin–Jumat 09:00–17:00 WIB, Sabtu 09:00–13:00 WIB",
    );
    expect(stdSupport.platformChannel.responseTarget).toBe("< 2 jam kerja");

    // 7. Agency-managed tenant automatically detects agency_client_links and routes to agency FIRST
    const agencySupport = await loadDashboardSupportContext(env.PLATFORM_DB, {
      tenantId: "tnt_cli_1",
      handle: "klinik-harapan",
      screen: "offering",
    });
    expect(agencySupport.mode).toBe("agency_first");
    expect(agencySupport.primaryChannel.kind).toBe("agency");
    if (agencySupport.primaryChannel.kind === "agency") {
      expect(agencySupport.primaryChannel.agencyId).toBe("agn_t105_1");
      expect(agencySupport.primaryChannel.agencyName).toBe("Agensi Digital Nusantara");
      expect(agencySupport.primaryChannel.email).toBe("support@agensinusantara.id");
      expect(agencySupport.primaryChannel.fallbackNote).toContain("Agensi Digital Nusantara");
    }
    expect(agencySupport.platformChannel.whatsappNumber).toBe("6281298765432");
    expect(agencySupport.platformChannel.supportHours).toBe(
      "Senin–Jumat 09:00–17:00 WIB, Sabtu 09:00–13:00 WIB",
    );

    // 8. Suspended agency MUST NOT hijack support routing -> falls back cleanly to platform support
    await env.PLATFORM_DB.prepare("UPDATE agencies SET status = 'suspended' WHERE id = 'agn_t105_1'").run();
    const suspendedAgencySupport = await loadDashboardSupportContext(env.PLATFORM_DB, {
      tenantId: "tnt_cli_1",
      handle: "klinik-harapan",
      screen: "offering",
    });
    expect(suspendedAgencySupport.mode).toBe("platform");
    expect(suspendedAgencySupport.primaryChannel.kind).toBe("platform");
    expect(suspendedAgencySupport.primaryChannel.whatsappNumber).toBe("6281298765432");

    // 9. Active agency with NO explicit billing_email MUST NOT expose owner's private users.email
    await env.PLATFORM_DB.batch([
      env.PLATFORM_DB.prepare("UPDATE agencies SET status = 'active' WHERE id = 'agn_t105_1'"),
      env.PLATFORM_DB.prepare("DELETE FROM agency_enrollment_records WHERE agency_id = 'agn_t105_1'"),
    ]);
    const noEmailAgencySupport = await loadDashboardSupportContext(env.PLATFORM_DB, {
      tenantId: "tnt_cli_1",
      handle: "klinik-harapan",
      screen: "offering",
    });
    expect(noEmailAgencySupport.mode).toBe("agency_first");
    expect(noEmailAgencySupport.primaryChannel.kind).toBe("agency");
    if (noEmailAgencySupport.primaryChannel.kind === "agency") {
      expect(noEmailAgencySupport.primaryChannel.agencyName).toBe("Agensi Digital Nusantara");
      expect(noEmailAgencySupport.primaryChannel.email).toBeNull();
      expect(noEmailAgencySupport.primaryChannel.mailtoUrl).toBeNull();
      expect(JSON.stringify(noEmailAgencySupport)).not.toContain("agency-owner@example.com");
    }

    // 10. Revoked/removed agency_client_links row MUST NOT hijack support even if tenants.agency_id lingers
    await env.PLATFORM_DB.prepare("DELETE FROM agency_client_links WHERE tenant_id = 'tnt_cli_1'").run();
    const revokedLinkSupport = await loadDashboardSupportContext(env.PLATFORM_DB, {
      tenantId: "tnt_cli_1",
      handle: "klinik-harapan",
      screen: "offering",
    });
    expect(revokedLinkSupport.mode).toBe("platform");
    expect(revokedLinkSupport.primaryChannel.kind).toBe("platform");
    expect(revokedLinkSupport.primaryChannel.whatsappNumber).toBe("6281298765432");
  });
});

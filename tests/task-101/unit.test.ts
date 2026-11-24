import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { validatePluginMigrationSql } from "@punyasitus/core/plugins/index";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ACTIVE_ON_PROVISION_PLUGIN_IDS,
  DEFAULT_PLUGIN_REGISTRY,
  REGISTERED_FIRST_PARTY_PLUGINS,
} from "../../apps/web/src/core/plugin-registry.ts";
import {
  LEAD_NOTIFIER_MANIFEST,
  LEAD_NOTIFIER_MIGRATIONS,
  LEAD_NOTIFIER_PLUGIN,
  LEAD_NOTIFIER_PLUGIN_ID,
  LeadNotifierConfigSchema,
  TELEGRAM_LINK_TOKEN_TTL_MS,
  TELEGRAM_WEBHOOK_SECRET_HEADER,
  WEBHOOK_DELIVERY_ID_HEADER,
  WEBHOOK_EVENT_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  buildWebhookSignatureHeader,
  canViewFullWebhookTargetUrl,
  deliverSignedHttpsWebhook,
  deliverTelegramLeadAlert,
  formatTelegramLeadMessage,
  generateTelegramLinkToken,
  generateWebhookSigningSecret,
  isPrivateOrReservedIpv4,
  isPrivateOrReservedIpv6,
  maskSigningSecret,
  maskTelegramChatLabel,
  normalizeLeadPayload,
  parseLeadNotifierConfig,
  parseTelegramLinkToken,
  parseTelegramStartUpdate,
  resolveTelegramBotToken,
  resolveWebhookEntitlement,
  sha256Hex,
  validateWebhookTargetUrl,
  verifyTelegramWebhookSecret,
  verifyWebhookSignature,
} from "../../packages/plugins/lead-notifier/index.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const NOW_MS = Date.UTC(2026, 10, 24, 2, 0, 0);

describe("TASK-101 Unit: Frozen-Core Boundary, Registry, Entitlement Security, Token Security, SSRF, HMAC & Formatter", () => {
  it("enforces Frozen Core Zero-Edit Rule: git working tree touches ONLY allowed TASK-101 paths", () => {
    const raw = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });

    const changedPaths = raw
      .split("\n")
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .map((line) => {
        const payload = line.slice(3).trim();
        const arrowIdx = payload.indexOf(" -> ");
        return arrowIdx >= 0 ? payload.slice(arrowIdx + 4) : payload;
      })
      .filter((p) => !p.startsWith(".delivery/"));

    const isAllowedPath = (p: string): boolean =>
      p.startsWith("packages/plugins/lead-notifier/") ||
      p === "apps/web/src/core/plugin-registry.ts" ||
      p === "docs/api/plugin-lead-notifier.md" ||
      p.startsWith("tests/task-101/");

    const violations = changedPaths.filter((p) => !isAllowedPath(p));
    expect(violations).toEqual([]);
  });

  it("registers LEAD_NOTIFIER_PLUGIN in DEFAULT_PLUGIN_REGISTRY without enabling it by default on provision", () => {
    expect(REGISTERED_FIRST_PARTY_PLUGINS).toContain(LEAD_NOTIFIER_PLUGIN);
    expect(DEFAULT_PLUGIN_REGISTRY.has(LEAD_NOTIFIER_PLUGIN_ID)).toBe(true);
    expect(DEFAULT_PLUGIN_REGISTRY.findByQueueHook("lead.created").map((d) => d.manifest.id)).toContain(
      LEAD_NOTIFIER_PLUGIN_ID,
    );
    expect(DEFAULT_ACTIVE_ON_PROVISION_PLUGIN_IDS as readonly string[]).not.toContain(
      LEAD_NOTIFIER_PLUGIN_ID,
    );
    expect(LEAD_NOTIFIER_MANIFEST.maxPublicJsBytes).toBe(0);
    expect(LEAD_NOTIFIER_MANIFEST.tablePrefix).toBe("plg_lead_notifier__");

    for (const mig of LEAD_NOTIFIER_MIGRATIONS) {
      const validated = validatePluginMigrationSql(LEAD_NOTIFIER_PLUGIN_ID, mig.sql);
      expect(validated.tablePrefix).toBe("plg_lead_notifier__");
      expect(validated.statementCount).toBeGreaterThanOrEqual(4);
      for (const obj of validated.touchedObjects) {
        expect(obj.startsWith("plg_lead_notifier__")).toBe(true);
      }
    }
  });

  it("HIGH-1: rejects tenant self-grant of webhookEntitled in config schema and resolves entitlement strictly from server state", async () => {
    // Tenant attempting to write `webhookEntitled: true` into plugin config MUST be rejected!
    const selfGrantAttempt = LeadNotifierConfigSchema.safeParse({
      telegramEnabled: true,
      webhookEnabled: true,
      webhookEntitled: true,
    });
    expect(selfGrantAttempt.success).toBe(false);

    // Even `parseLeadNotifierConfig` strips unknown keys and never exposes `webhookEntitled`
    const parsed = parseLeadNotifierConfig({
      telegramEnabled: true,
      webhookEnabled: true,
      webhookEntitled: true,
    });
    expect("webhookEntitled" in parsed).toBe(false);

    // Server-side entitlement check ignores forged config completely
    expect(
      await resolveWebhookEntitlement({
        tenantId: "tenant_a",
        ctx: { config: { webhookEntitled: true } },
      }),
    ).toBe(false);

    // Server-side entitlement grants via platform entitlement object or server resolver succeed
    expect(
      await resolveWebhookEntitlement({
        tenantId: "tenant_a",
        ctx: { entitlement: { capabilities: ["signed_https_webhook"] } },
      }),
    ).toBe(true);
    expect(
      await resolveWebhookEntitlement({
        tenantId: "tenant_a",
        ctx: { entitlement: { sourceKind: "paid_monthly" } },
      }),
    ).toBe(true);
    expect(
      await resolveWebhookEntitlement({
        tenantId: "tenant_a",
        options: { webhookEntitledTenantIds: ["tenant_a"] },
      }),
    ).toBe(true);
    expect(
      await resolveWebhookEntitlement({
        tenantId: "tenant_b",
        options: { webhookEntitledTenantIds: ["tenant_a"] },
      }),
    ).toBe(false);

    // Role check for full webhook targetUrl visibility (MEDIUM-3)
    expect(canViewFullWebhookTargetUrl("owner")).toBe(true);
    expect(canViewFullWebhookTargetUrl("admin")).toBe(true);
    expect(canViewFullWebhookTargetUrl("agency_admin")).toBe(true);
    expect(canViewFullWebhookTargetUrl("editor")).toBe(false);
    expect(canViewFullWebhookTargetUrl("viewer")).toBe(false);

    // Workers runtime `ctx.env.TELEGRAM_BOT_TOKEN` resolution takes priority over process.env (MEDIUM-4)
    expect(
      resolveTelegramBotToken({ env: { TELEGRAM_BOT_TOKEN: "111:WORKERS_ENV_TOKEN" } }),
    ).toBe("111:WORKERS_ENV_TOKEN");
  });

  it("Admin UI island obeys base-nova rules: zero Sparkles, zero @radix-ui, zero asChild, explicit htmlFor", () => {
    const islandPath = path.join(
      REPO_ROOT,
      "packages/plugins/lead-notifier/src/admin/SettingsIsland.tsx",
    );
    const source = fs.readFileSync(islandPath, "utf8");
    expect(source).not.toMatch(/Sparkles/);
    expect(source).not.toMatch(/@radix-ui\//);
    expect(source).not.toMatch(/\basChild\b/);
    expect(source).toContain('htmlFor="ln-webhook-url"');
    expect(source).toContain('id="ln-webhook-url"');
    expect(source).toContain('htmlFor="ln-webhook-enabled"');
    expect(source).toContain('id="ln-webhook-enabled"');
    expect(source).toContain("Hubungkan Telegram");
    expect(source).toContain("Putuskan Telegram");
  });

  it("generates 15-minute single-use Telegram link tokens (<= 64 chars) with SHA-256 hash & parses /start updates", async () => {
    const tenantId = "01JT101TENANTALPHA00000001";
    const tok1 = await generateTelegramLinkToken({
      tenantId,
      botUsername: "PunyaSitusBot",
      nowMs: NOW_MS,
    });
    const tok2 = await generateTelegramLinkToken({
      tenantId,
      botUsername: "PunyaSitusBot",
      nowMs: NOW_MS,
    });

    expect(tok1.plaintextToken).not.toBe(tok2.plaintextToken);
    expect(tok1.tokenHash).not.toBe(tok2.tokenHash);
    expect(tok1.plaintextToken.length).toBeLessThanOrEqual(64);
    expect(/^[A-Za-z0-9_-]{20,64}$/.test(tok1.plaintextToken)).toBe(true);
    expect(tok1.tokenHash).toBe(await sha256Hex(tok1.plaintextToken));
    expect(tok1.tokenHash).not.toContain(tok1.plaintextToken);
    expect(tok1.expiresAt - tok1.createdAt).toBe(TELEGRAM_LINK_TOKEN_TTL_MS);
    expect(tok1.expiresInSeconds).toBe(900);
    expect(tok1.deepLink).toBe(`https://t.me/PunyaSitusBot?start=${tok1.plaintextToken}`);

    const parsed = parseTelegramLinkToken(tok1.plaintextToken);
    expect(parsed).not.toBeNull();
    expect(parsed?.tenantId).toBe(tenantId);
    expect(parsed?.nonce.length).toBeGreaterThanOrEqual(16);

    const updateBody = JSON.stringify({
      update_id: 9001,
      message: {
        text: `/start@PunyaSitusBot ${tok1.plaintextToken}`,
        chat: { id: 123456789, type: "private", username: "budi_santoso", first_name: "Budi" },
      },
    });
    const parsedUpdate = parseTelegramStartUpdate(updateBody);
    expect(parsedUpdate).not.toBeNull();
    expect(parsedUpdate?.tenantId).toBe(tenantId);
    expect(parsedUpdate?.chatId).toBe("123456789");
    expect(parsedUpdate?.token).toBe(tok1.plaintextToken);

    expect(
      parseTelegramStartUpdate(
        JSON.stringify({ message: { text: "/help", chat: { id: 1 } } }),
      ),
    ).toBeNull();
    expect(parseTelegramLinkToken("invalid-short-token")).toBeNull();

    expect(maskTelegramChatLabel({ username: "budi_santoso", chatId: "123456789" })).toBe("@bu***so");
    expect(maskTelegramChatLabel({ displayName: "Siti Rahma", chatId: "987654321" })).toBe("Si***i Ra***a");
    expect(maskTelegramChatLabel({ chatId: "987654321" })).toBe("Telegram #***4321");
  });

  it("verifies X-Telegram-Bot-Api-Secret-Token in constant time and fails closed when unconfigured", () => {
    const secret = "tg-wh-secret-2026-abcdef123456";
    const okReq = new Request("https://app.punyasitus.com/api/plugins/lead-notifier/webhook", {
      method: "POST",
      headers: { [TELEGRAM_WEBHOOK_SECRET_HEADER]: secret },
    });
    const badReq = new Request("https://app.punyasitus.com/api/plugins/lead-notifier/webhook", {
      method: "POST",
      headers: { [TELEGRAM_WEBHOOK_SECRET_HEADER]: "tg-wh-secret-2026-abcdef123457" },
    });
    const missingHeaderReq = new Request(
      "https://app.punyasitus.com/api/plugins/lead-notifier/webhook",
      { method: "POST" },
    );

    expect(verifyTelegramWebhookSecret(okReq, { TELEGRAM_WEBHOOK_SECRET: secret })).toBe(true);
    expect(verifyTelegramWebhookSecret(badReq, { TELEGRAM_WEBHOOK_SECRET: secret })).toBe(false);
    expect(verifyTelegramWebhookSecret(missingHeaderReq, { TELEGRAM_WEBHOOK_SECRET: secret })).toBe(
      false,
    );
    expect(verifyTelegramWebhookSecret(okReq, {})).toBe(false);
    expect(verifyTelegramWebhookSecret(okReq, { TELEGRAM_WEBHOOK_SECRET: "   " })).toBe(false);
  });

  it("formats Telegram lead alerts with valid wa.me CTA, truncates BEFORE HTML escaping (zero split entities), and handles missing phone", () => {
    const leadWithPhone = normalizeLeadPayload(
      {
        leadId: 42,
        name: "Rina <script>alert(1)</script>",
        phoneE164: "0812-3456-7890",
        email: "rina@contoh.id",
        message: `${"&<>\" ".repeat(200)}akhir`,
        pagePath: "/layanan/renovasi",
        tenantName: "PT Nusantara Arsitek",
      },
      { tenantId: "t1", eventId: "lead:42", nowMs: NOW_MS },
    );

    const formatted = formatTelegramLeadMessage("123456789", leadWithPhone);
    expect(formatted.whatsappFollowUp).not.toBeNull();
    expect(formatted.whatsappFollowUp?.normalizedPhone).toBe("6281234567890");
    expect(formatted.whatsappFollowUp?.url).toMatch(/^https:\/\/wa\.me\/6281234567890\?text=/);
    expect(formatted.payload.reply_markup?.inline_keyboard[0]?.[0]?.text).toBe("Balas via WhatsApp");
    expect(formatted.payload.text.length).toBeLessThanOrEqual(3900);
    expect(formatted.payload.text).not.toContain("<script>");
    expect(formatted.payload.text).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    // Verify zero truncated/dangling HTML entities (every `&` starts a complete `&amp;`/`&lt;`/`&gt;`/`&quot;`)
    const danglingEntities = formatted.payload.text.match(/&(?!(?:amp|lt|gt|quot);)/g);
    expect(danglingEntities).toBeNull();

    const leadNoPhone = normalizeLeadPayload(
      {
        leadId: 43,
        name: "Andi",
        email: "andi@contoh.id",
        message: "Mohon kirim brosur via email.",
        tenantName: "PT Nusantara Arsitek",
      },
      { tenantId: "t1", eventId: "lead:43", nowMs: NOW_MS },
    );
    const noPhoneMsg = formatTelegramLeadMessage("123456789", leadNoPhone);
    expect(noPhoneMsg.whatsappFollowUp).toBeNull();
    expect(noPhoneMsg.payload.reply_markup).toBeUndefined();
    expect(noPhoneMsg.payload.text).toContain("WhatsApp: Tidak tersedia");
  });

  it("signs and verifies HMAC-SHA256 webhook payloads with replay tolerance and masked secret display", async () => {
    const secret = generateWebhookSigningSecret();
    expect(secret).toMatch(/^whsec_[a-f0-9]{48}$/);
    const masked = maskSigningSecret(secret);
    expect(masked).toBe(`whsec_****${secret.slice(-4)}`);
    expect(masked).not.toBe(secret);

    const rawBody = JSON.stringify({ event: "lead.created", lead: { id: 101, name: "Dewi" } });
    const ts = Math.floor(NOW_MS / 1000);
    const header = await buildWebhookSignatureHeader(secret, rawBody, ts);
    expect(header).toMatch(/^t=\d+,v1=[a-f0-9]{64}$/);

    expect(
      await verifyWebhookSignature({
        rawBody,
        signatureHeader: header,
        secret,
        nowMs: NOW_MS + 30_000,
      }),
    ).toEqual({ ok: true, timestamp: ts });

    expect(
      await verifyWebhookSignature({
        rawBody: rawBody.replace("Dewi", "Hacker"),
        signatureHeader: header,
        secret,
        nowMs: NOW_MS + 30_000,
      }),
    ).toEqual({ ok: false, reason: "SIGNATURE_MISMATCH" });

    expect(
      await verifyWebhookSignature({
        rawBody,
        signatureHeader: header,
        secret: "whsec_000000000000000000000000000000000000000000000000",
        nowMs: NOW_MS + 30_000,
      }),
    ).toEqual({ ok: false, reason: "SIGNATURE_MISMATCH" });

    expect(
      await verifyWebhookSignature({
        rawBody,
        signatureHeader: header,
        secret,
        nowMs: NOW_MS + 600_000,
        toleranceSeconds: 300,
      }),
    ).toEqual({ ok: false, reason: "TIMESTAMP_EXPIRED" });
  });

  it("enforces comprehensive SSRF blocklist matrix (incl. DNS-rebinding suffixes) & refuses private and cross-origin redirects", async () => {
    const blockedUrls: readonly string[] = [
      // Non-HTTPS schemes
      "http://hooks.crm.example.com/leads",
      "ftp://hooks.crm.example.com/leads",
      "file:///etc/passwd",
      "javascript:alert(1)",
      // Embedded credentials & disallowed ports
      "https://admin:secret@hooks.crm.example.com/leads",
      "https://hooks.crm.example.com:80/leads",
      "https://hooks.crm.example.com:6379/leads",
      "https://hooks.crm.example.com:22/leads",
      // Localhost, internal suffixes, bare hostnames, and DNS-rebinding wildcard domains
      "https://localhost/webhook",
      "https://localhost./webhook",
      "https://api.localhost/webhook",
      "https://metadata.google.internal/computeMetadata/v1/",
      "https://service.internal/hook",
      "https://printer.local/hook",
      "https://router.home.arpa/hook",
      "https://redis/hook",
      "https://127.0.0.1.nip.io/hook",
      "https://169-254-169-254.sslip.io/hook",
      "https://10.0.0.1.xip.io/hook",
      "https://app.localtest.me/hook",
      "https://sub.lvh.me/hook",
      // Private / loopback / metadata / CGNAT / multicast IPv4 (including encoded forms)
      "https://127.0.0.1/hook",
      "https://127.255.255.254/hook",
      "https://127.1/hook",
      "https://2130706433/hook",
      "https://0x7f000001/hook",
      "https://0177.0.0.1/hook",
      "https://0.0.0.0/hook",
      "https://10.0.0.1/hook",
      "https://10.255.255.254/hook",
      "https://172.16.0.1/hook",
      "https://172.31.255.254/hook",
      "https://192.168.0.1/hook",
      "https://192.168.1.100/hook",
      "https://169.254.169.254/latest/meta-data/",
      "https://100.64.0.1/hook",
      "https://100.127.255.254/hook",
      "https://224.0.0.1/hook",
      "https://255.255.255.255/hook",
      // Private / loopback / ULA / link-local / IPv4-mapped IPv6
      "https://[::1]/hook",
      "https://[::]/hook",
      "https://[fc00::1]/hook",
      "https://[fd12:3456:789a::1]/hook",
      "https://[fe80::1]/hook",
      "https://[::ffff:127.0.0.1]/hook",
      "https://[::ffff:169.254.169.254]/hook",
      "https://[::ffff:10.0.0.1]/hook",
      "https://[::ffff:7f00:1]/hook",
      "https://[0:0:0:0:0:ffff:192.168.1.1]/hook",
      "https://[64:ff9b::10.0.0.1]/hook",
      "https://[2002:7f00:0001::1]/hook",
      "https://[fe80::1%25eth0]/hook",
    ];

    for (const url of blockedUrls) {
      const res = validateWebhookTargetUrl(url);
      expect(res.ok, `Expected SSRF guard to block: ${url}`).toBe(false);
    }

    const allowedUrls = [
      "https://hooks.crm.example.com/v1/leads",
      "https://script.google.com/macros/s/AKfycb123/exec",
      "https://hooks.zapier.com:8443/hooks/catch/12345/abc/",
      "https://n8n.agency.id/webhook/punyasitus",
    ];
    for (const url of allowedUrls) {
      const res = validateWebhookTargetUrl(url);
      expect(res.ok, `Expected SSRF guard to allow: ${url}`).toBe(true);
    }

    expect(isPrivateOrReservedIpv4("8.8.8.8")).toBe(false);
    expect(isPrivateOrReservedIpv4("172.15.255.255")).toBe(false);
    expect(isPrivateOrReservedIpv4("172.32.0.1")).toBe(false);
    expect(isPrivateOrReservedIpv6("2606:4700:4700::1111")).toBe(false);

    const lead = normalizeLeadPayload(
      { leadId: 1, name: "Budi", phoneE164: "+6281234567890", message: "Tes" },
      { tenantId: "t1", eventId: "evt_redirect", nowMs: NOW_MS },
    );

    // 1. Redirect hop to private IP is blocked without calling the private IP
    const visitedPrivate: string[] = [];
    const privateRedirectRes = await deliverSignedHttpsWebhook({
      targetUrl: "https://hooks.crm.example.com/leads",
      signingSecret: generateWebhookSigningSecret(),
      lead,
      transport: {
        fetchFn: async (input) => {
          visitedPrivate.push(String(input));
          return new Response(null, {
            status: 302,
            headers: { Location: "https://169.254.169.254/latest/meta-data/" },
          });
        },
        sleepFn: async () => {},
        nowMs: () => NOW_MS,
      },
    });
    expect(privateRedirectRes.ok).toBe(false);
    expect(privateRedirectRes.errorCode).toBe("SSRF_REDIRECT_BLOCKED");
    expect(visitedPrivate).toEqual(["https://hooks.crm.example.com/leads"]);

    // 2. Cross-origin redirect on signed webhook is strictly refused (signature never leaked!)
    const visitedCrossOrigin: string[] = [];
    const crossOriginRes = await deliverSignedHttpsWebhook({
      targetUrl: "https://hooks.crm.example.com/leads",
      signingSecret: generateWebhookSigningSecret(),
      lead,
      transport: {
        fetchFn: async (input) => {
          visitedCrossOrigin.push(String(input));
          return new Response(null, {
            status: 307,
            headers: { Location: "https://attacker.example.org/steal-sig" },
          });
        },
        sleepFn: async () => {},
        nowMs: () => NOW_MS,
      },
    });
    expect(crossOriginRes.ok).toBe(false);
    expect(crossOriginRes.errorCode).toBe("CROSS_ORIGIN_REDIRECT_BLOCKED");
    expect(visitedCrossOrigin).toEqual(["https://hooks.crm.example.com/leads"]);

    // 3. Same-origin HTTPS redirect is permitted up to hop cap
    const visitedSameOrigin: string[] = [];
    const sameOriginRes = await deliverSignedHttpsWebhook({
      targetUrl: "https://hooks.crm.example.com/v1/leads",
      signingSecret: generateWebhookSigningSecret(),
      lead,
      transport: {
        fetchFn: async (input) => {
          const u = String(input);
          visitedSameOrigin.push(u);
          if (u.endsWith("/v1/leads")) {
            return new Response(null, { status: 307, headers: { Location: "/v2/leads" } });
          }
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
        sleepFn: async () => {},
        nowMs: () => NOW_MS,
      },
    });
    expect(sameOriginRes.ok).toBe(true);
    expect(visitedSameOrigin).toEqual([
      "https://hooks.crm.example.com/v1/leads",
      "https://hooks.crm.example.com/v2/leads",
    ]);
  });

  it("enforces bounded retries, global deadline budget, and non-blocking failure isolation on 500/timeout", async () => {
    const lead = normalizeLeadPayload(
      { leadId: 77, name: "Sari", phoneE164: "+6281299998888", message: "Halo" },
      { tenantId: "t1", eventId: "evt_retry", nowMs: NOW_MS },
    );

    // 1. Webhook retries twice on 500 then succeeds on attempt 3 with valid HMAC signature
    const secret = generateWebhookSigningSecret();
    let attemptCount = 0;
    let lastSigHeader = "";
    let lastEventHeader = "";
    let lastDeliveryId = "";
    let lastBody = "";

    const retryOk = await deliverSignedHttpsWebhook({
      targetUrl: "https://hooks.crm.example.com/leads",
      signingSecret: secret,
      lead,
      maxRetries: 3,
      transport: {
        fetchFn: async (_url, init) => {
          attemptCount += 1;
          const headers = new Headers(init?.headers);
          lastSigHeader = headers.get(WEBHOOK_SIGNATURE_HEADER) ?? "";
          lastEventHeader = headers.get(WEBHOOK_EVENT_HEADER) ?? "";
          lastDeliveryId = headers.get(WEBHOOK_DELIVERY_ID_HEADER) ?? "";
          lastBody = String(init?.body ?? "");
          if (attemptCount < 3) {
            return new Response("upstream error", { status: 500 });
          }
          return new Response(JSON.stringify({ received: true }), { status: 200 });
        },
        sleepFn: async () => {},
        nowMs: () => NOW_MS,
      },
    });

    expect(retryOk.ok).toBe(true);
    expect(retryOk.status).toBe("delivered");
    expect(retryOk.attempts).toBe(3);
    expect(lastEventHeader).toBe("lead.created");
    expect(lastDeliveryId).toBe(retryOk.deliveryId);
    expect(
      await verifyWebhookSignature({
        rawBody: lastBody,
        signatureHeader: lastSigHeader,
        secret,
        nowMs: NOW_MS,
      }),
    ).toMatchObject({ ok: true });

    // 2. Single global deadline budget caps total elapsed wall time across attempts
    const startedAt = Date.now();
    const budgetRes = await deliverSignedHttpsWebhook({
      targetUrl: "https://hooks.crm.example.com/slow",
      signingSecret: secret,
      lead,
      maxRetries: 3,
      transport: {
        timeoutMs: 80,
        totalDeadlineMs: 110,
        retryBaseDelayMs: 50,
        fetchFn: (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              const err = new Error("Aborted");
              err.name = "AbortError";
              reject(err);
            });
          }),
      },
    });
    const elapsedMs = Date.now() - startedAt;
    expect(budgetRes.ok).toBe(false);
    expect(budgetRes.status).toBe("timed_out");
    expect(elapsedMs).toBeLessThan(400);

    // 3. Telegram hard timeout NEVER throws — returns `timed_out` cleanly
    const timeoutRes = await deliverTelegramLeadAlert({
      botToken: "123456:TEST_TOKEN",
      chatId: "99887766",
      maskedChatLabel: "@sa***ri",
      lead,
      maxAttempts: 1,
      transport: {
        timeoutMs: 60,
        totalDeadlineMs: 90,
        fetchFn: (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              const err = new Error("Aborted");
              err.name = "AbortError";
              reject(err);
            });
          }),
        sleepFn: async () => {},
      },
    });
    expect(timeoutRes.ok).toBe(false);
    expect(timeoutRes.status).toBe("timed_out");
    expect(timeoutRes.errorCode).toBe("REQUEST_TIMEOUT");
  });
});

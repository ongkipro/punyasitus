import {
  ApiErrorSchema,
  PublicAbuseReportRequestSchema,
  PublicEventIngestRequestSchema,
  PublicLeadSubmitRequestSchema,
} from "@punyasitus/core/schemas";
import {
  canonicalizeLeadPayload,
  checkOrClaimLeadIdempotency,
  executeIdempotentLeadWrite,
  hashLeadPayload,
} from "@punyasitus/db/lead-dedup/index";
import {
  buildNetworkBucketKey,
  consumeRateLimitBucket,
  enforceEventRateLimit,
  enforceLeadRateLimit,
  extractClientIp,
  hashNetworkIdentifier,
} from "@punyasitus/db/rate-limits/index";
import { describe, expect, it } from "vitest";
import {
  createPublicInputErrorResponse,
  DEFAULT_PUBLIC_POST_MAX_BYTES,
  PUBLIC_ABUSE_REPORT_ALLOWED_CONTENT_TYPES,
  PUBLIC_EVENT_ALLOWED_CONTENT_TYPES,
  PUBLIC_LEAD_ALLOWED_CONTENT_TYPES,
  validatePublicPostOrigin,
  validatePublicPostRequest,
} from "../../apps/web/src/core/public-input.ts";

const TEST_HOST = "alpha-studio.situsku.click";
const TEST_ORIGIN = `https://${TEST_HOST}`;
const TEST_SALT = "unit-test-rate-limit-salt-v1";

function createJsonRequest(
  body: string | Uint8Array,
  headers: Record<string, string> = {},
): Request {
  const payload = typeof body === "string" ? body : new Uint8Array(body);
  return new Request(`${TEST_ORIGIN}/api/leads`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: TEST_ORIGIN,
      ...headers,
    },
    body: payload,
  });
}

function createFormRequest(
  body: string | Uint8Array,
  headers: Record<string, string> = {},
  contentType = "application/x-www-form-urlencoded",
): Request {
  const payload = typeof body === "string" ? body : new Uint8Array(body);
  return new Request(`${TEST_ORIGIN}/api/leads`, {
    method: "POST",
    headers: {
      "content-type": contentType,
      ...headers,
    },
    body: payload,
  });
}

function createFailingDb(message = "D1_UNAVAILABLE"): D1Database {
  const failingStmt = {
    bind() {
      return this;
    },
    async first() {
      throw new Error(message);
    },
    async run() {
      throw new Error(message);
    },
    async all() {
      throw new Error(message);
    },
    async raw() {
      throw new Error(message);
    },
  } as unknown as D1PreparedStatement;

  return {
    prepare() {
      return failingStmt;
    },
    async batch() {
      throw new Error(message);
    },
    async exec() {
      throw new Error(message);
    },
  } as unknown as D1Database;
}

describe("TASK-029 unit — Privacy-preserving rate-limit keys & canonical payload hashing", () => {
  it("hashes CF-Connecting-IP with HMAC-SHA256 without ever exposing raw IP", async () => {
    const ipv4 = "203.0.113.42";
    const ipv6 = "2001:0DB8::ABCD";

    const hashA1 = await hashNetworkIdentifier(ipv4, TEST_SALT);
    const hashA2 = await hashNetworkIdentifier(`  ${ipv4} `, TEST_SALT);
    const hashOtherSalt = await hashNetworkIdentifier(ipv4, "different-salt-v2");
    const hashIpv6Upper = await hashNetworkIdentifier(ipv6, TEST_SALT);
    const hashIpv6Lower = await hashNetworkIdentifier(ipv6.toLowerCase(), TEST_SALT);

    expect(hashA1).toMatch(/^[a-f0-9]{64}$/);
    expect(hashA1).toBe(hashA2);
    expect(hashA1).not.toBe(hashOtherSalt);
    expect(hashIpv6Upper).toBe(hashIpv6Lower);

    const key = await buildNetworkBucketKey({
      scope: "lead",
      tenantId: "01JTESTTENANTALPHA00000001",
      clientIp: ipv4,
      salt: TEST_SALT,
    });
    expect(key).not.toContain(ipv4);
    expect(key).toBe(`lead:t:01JTESTTENANTALPHA00000001:net:${hashA1}`);

    await expect(hashNetworkIdentifier(ipv4, "   ")).rejects.toThrow(/INVALID_RATE_LIMIT_SALT/);
  });

  it("extracts client IP strictly from CF-Connecting-IP and ignores X-Forwarded-For", () => {
    const spoofedOnly = new Request(`${TEST_ORIGIN}/api/leads`, {
      method: "POST",
      headers: {
        "x-forwarded-for": "198.51.100.99",
        "x-real-ip": "198.51.100.98",
      },
    });
    expect(extractClientIp(spoofedOnly)).toBeNull();

    const cfReq = new Request(`${TEST_ORIGIN}/api/leads`, {
      method: "POST",
      headers: {
        "cf-connecting-ip": "203.0.113.7",
        "x-forwarded-for": "198.51.100.99",
      },
    });
    expect(extractClientIp(cfReq)).toBe("203.0.113.7");
  });

  it("computes deterministic canonical SHA-256 payload hashes regardless of key order", async () => {
    const p1 = {
      name: "Budi Santoso",
      phone: "6281234567890",
      message: "Halo, mau tanya paket",
      customFields: { b: "two", a: "one" },
      email: undefined,
    };
    const p2 = {
      customFields: { a: "one", b: "two" },
      message: "Halo, mau tanya paket",
      phone: "6281234567890",
      name: "Budi Santoso",
    };
    const p3 = { ...p2, message: "Halo, mau tanya harga" };

    expect(canonicalizeLeadPayload(p1)).toBe(canonicalizeLeadPayload(p2));
    const h1 = await hashLeadPayload(p1);
    const h2 = await hashLeadPayload(p2);
    const h3 = await hashLeadPayload(p3);

    expect(h1).toMatch(/^[a-f0-9]{64}$/);
    expect(h1).toBe(h2);
    expect(h1).not.toBe(h3);
  });

  it("fails closed with 503 when rate-limit or lead-dedup datastores are unavailable", async () => {
    const failingDb = createFailingDb("SQLITE_BUSY");

    const rlNull = await consumeRateLimitBucket(null, {
      bucketKey: "lead:t:alpha:net:abc",
      limit: 5,
      windowMs: 60_000,
    });
    expect(rlNull).toMatchObject({ ok: false, kind: "datastore_unavailable", status: 503 });

    const rlErr = await enforceLeadRateLimit(failingDb, {
      tenantId: "01JTESTTENANTALPHA00000001",
      clientIp: "203.0.113.10",
      salt: TEST_SALT,
    });
    expect(rlErr).toMatchObject({ ok: false, kind: "datastore_unavailable", status: 503 });

    const evErr = await enforceEventRateLimit(failingDb, {
      tenantId: "01JTESTTENANTALPHA00000001",
      clientIp: "203.0.113.10",
      salt: TEST_SALT,
    });
    expect(evErr).toMatchObject({ ok: false, kind: "datastore_unavailable", status: 503 });

    const dedupCheckErr = await checkOrClaimLeadIdempotency(failingDb, {
      idempotencyKey: "11111111-1111-4111-8111-111111111111",
      payloadHash: "a".repeat(64),
    });
    expect(dedupCheckErr).toMatchObject({ ok: false, kind: "datastore_unavailable", status: 503 });

    const dedupWriteErr = await executeIdempotentLeadWrite(failingDb, {
      idempotencyKey: "11111111-1111-4111-8111-111111111111",
      lead: {
        name: "Budi",
        phoneE164: "6281234567890",
        message: "Test",
      },
    });
    expect(dedupWriteErr).toMatchObject({ ok: false, kind: "datastore_unavailable", status: 503 });
  });
});

describe("TASK-029 unit — PLAN §6 Origin & Sec-Fetch-Site matrix", () => {
  it("accepts matching Origin for JSON and form requests", () => {
    const req = createJsonRequest('{"name":"Budi"}');
    const res = validatePublicPostOrigin(req, { tenantHost: TEST_HOST });
    expect(res).toEqual({ ok: true, tenantHost: TEST_HOST, expectedOrigin: TEST_ORIGIN });
  });

  it("rejects cross-origin and literal null Origin with 403", () => {
    const crossOrigin = createJsonRequest('{"name":"Budi"}', {
      origin: "https://evil.example",
    });
    expect(validatePublicPostOrigin(crossOrigin, { tenantHost: TEST_HOST })).toMatchObject({
      ok: false,
      status: 403,
      code: "ORIGIN_MISMATCH",
      apiErrorCode: "FORBIDDEN",
    });

    const otherTenant = createJsonRequest('{"name":"Budi"}', {
      origin: "https://beta-klinik.situsku.click",
    });
    expect(validatePublicPostOrigin(otherTenant, { tenantHost: TEST_HOST })).toMatchObject({
      ok: false,
      status: 403,
      code: "ORIGIN_MISMATCH",
    });

    const httpScheme = createJsonRequest('{"name":"Budi"}', {
      origin: `http://${TEST_HOST}`,
    });
    expect(validatePublicPostOrigin(httpScheme, { tenantHost: TEST_HOST })).toMatchObject({
      ok: false,
      status: 403,
      code: "ORIGIN_MISMATCH",
    });

    const nullOrigin = createJsonRequest('{"name":"Budi"}', { origin: "null" });
    expect(validatePublicPostOrigin(nullOrigin, { tenantHost: TEST_HOST })).toMatchObject({
      ok: false,
      status: 403,
      code: "NULL_ORIGIN",
      apiErrorCode: "FORBIDDEN",
    });

    const nullOriginForm = createFormRequest("name=Budi", { origin: "NULL" });
    expect(validatePublicPostOrigin(nullOriginForm, { tenantHost: TEST_HOST })).toMatchObject({
      ok: false,
      status: 403,
      code: "NULL_ORIGIN",
    });
  });

  it("rejects missing Origin on non-form requests (JSON, text/plain, missing Content-Type)", () => {
    const jsonNoOrigin = new Request(`${TEST_ORIGIN}/api/leads`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"name":"Budi"}',
    });
    expect(validatePublicPostOrigin(jsonNoOrigin, { tenantHost: TEST_HOST })).toMatchObject({
      ok: false,
      status: 403,
      code: "MISSING_ORIGIN",
    });

    const textNoOrigin = new Request(`${TEST_ORIGIN}/api/leads`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "hello",
    });
    expect(validatePublicPostOrigin(textNoOrigin, { tenantHost: TEST_HOST })).toMatchObject({
      ok: false,
      status: 403,
      code: "MISSING_ORIGIN",
    });

    const noCtNoOrigin = new Request(`${TEST_ORIGIN}/api/leads`, {
      method: "POST",
      body: "hello",
    });
    expect(validatePublicPostOrigin(noCtNoOrigin, { tenantHost: TEST_HOST })).toMatchObject({
      ok: false,
      status: 403,
      code: "MISSING_ORIGIN",
    });
  });

  it("enforces exact Sec-Fetch-Site matrix for missing-Origin HTML form POSTs", () => {
    for (const badSite of ["cross-site", "same-site", "none"] as const) {
      const req = createFormRequest("name=Budi", { "sec-fetch-site": badSite });
      expect(validatePublicPostOrigin(req, { tenantHost: TEST_HOST })).toMatchObject({
        ok: false,
        status: 403,
        code: "CROSS_SITE_FORM",
        apiErrorCode: "FORBIDDEN",
      });
    }

    const multipartCrossSite = createFormRequest(
      "--b\r\nContent-Disposition: form-data; name=\"name\"\r\n\r\nBudi\r\n--b--",
      { "sec-fetch-site": "cross-site" },
      "multipart/form-data; boundary=b",
    );
    expect(validatePublicPostOrigin(multipartCrossSite, { tenantHost: TEST_HOST })).toMatchObject({
      ok: false,
      status: 403,
      code: "CROSS_SITE_FORM",
    });

    // Accepted no-JS progressive enhancement cases: Sec-Fetch-Site same-origin OR absent
    const sameOriginForm = createFormRequest("name=Budi", { "sec-fetch-site": "same-origin" });
    expect(validatePublicPostOrigin(sameOriginForm, { tenantHost: TEST_HOST })).toEqual({
      ok: true,
      tenantHost: TEST_HOST,
      expectedOrigin: TEST_ORIGIN,
    });

    const absentSecFetchForm = createFormRequest("name=Budi");
    expect(validatePublicPostOrigin(absentSecFetchForm, { tenantHost: TEST_HOST })).toEqual({
      ok: true,
      tenantHost: TEST_HOST,
      expectedOrigin: TEST_ORIGIN,
    });

    const absentSecFetchMultipart = createFormRequest(
      "--b\r\nContent-Disposition: form-data; name=\"name\"\r\n\r\nBudi\r\n--b--",
      {},
      "multipart/form-data; boundary=b",
    );
    expect(validatePublicPostOrigin(absentSecFetchMultipart, { tenantHost: TEST_HOST })).toEqual({
      ok: true,
      tenantHost: TEST_HOST,
      expectedOrigin: TEST_ORIGIN,
    });
  });
});

describe("TASK-029 unit — Body limits, forged tenant, decoding, honeypot & schema validation", () => {
  it("enforces 16 KiB limit via Content-Length AND streaming ReadableStream without Content-Length", async () => {
    const emptyTemplate = JSON.stringify({
      name: "Budi",
      phone: "6281234567890",
      message: "",
    });
    const exactPayload = JSON.stringify({
      name: "Budi",
      phone: "6281234567890",
      message: "a".repeat(DEFAULT_PUBLIC_POST_MAX_BYTES - emptyTemplate.length),
    });
    expect(new TextEncoder().encode(exactPayload).byteLength).toBe(DEFAULT_PUBLIC_POST_MAX_BYTES);

    const exactOk = await validatePublicPostRequest(createJsonRequest(exactPayload), {
      tenantHost: TEST_HOST,
    });
    expect(exactOk.ok).toBe(true);

    // 1. Over limit with explicit Content-Length header
    const overBody = JSON.stringify({ message: "x".repeat(DEFAULT_PUBLIC_POST_MAX_BYTES + 1) });
    const overHeaderReq = createJsonRequest(overBody, {
      "content-length": String(new TextEncoder().encode(overBody).byteLength),
    });
    const overHeaderRes = await validatePublicPostRequest(overHeaderReq, {
      tenantHost: TEST_HOST,
    });
    expect(overHeaderRes).toMatchObject({
      ok: false,
      status: 413,
      code: "PAYLOAD_TOO_LARGE",
      apiErrorCode: "PAYLOAD_TOO_LARGE",
    });

    // 2. Streamed body without Content-Length exceeding 16 KiB
    const chunk = new Uint8Array(4096).fill(0x61); // 'a'
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"message":"'));
        for (let i = 0; i < 5; i += 1) {
          controller.enqueue(chunk);
        }
        controller.enqueue(new TextEncoder().encode('"}'));
        controller.close();
      },
    });
    const streamedReq = new Request(`${TEST_ORIGIN}/api/leads`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: TEST_ORIGIN,
      },
      body: stream,
      duplex: "half",
    } as RequestInit);

    const streamedRes = await validatePublicPostRequest(streamedReq, {
      tenantHost: TEST_HOST,
    });
    expect(streamedRes).toMatchObject({
      ok: false,
      status: 413,
      code: "PAYLOAD_TOO_LARGE",
      apiErrorCode: "PAYLOAD_TOO_LARGE",
    });
  });

  it("rejects forged tenantId / tenant_id fields and ignores spoofed tenant headers", async () => {
    const forgedJson = createJsonRequest(
      JSON.stringify({
        tenantId: "01JTESTTENANTBETA000000002",
        name: "Budi",
        phone: "6281234567890",
        message: "Halo",
      }),
      {
        "x-tenant-id": "01JTESTTENANTBETA000000002",
        "x-forwarded-host": "beta-klinik.situsku.click",
      },
    );
    const res1 = await validatePublicPostRequest(forgedJson, {
      tenantHost: TEST_HOST,
      schema: PublicLeadSubmitRequestSchema,
    });
    expect(res1).toMatchObject({
      ok: false,
      status: 422,
      code: "FORGED_TENANT_FIELD",
      apiErrorCode: "VALIDATION_ERROR",
    });

    const forgedSnake = createFormRequest(
      "tenant_id=01JTESTTENANTBETA000000002&name=Budi&phone=6281234567890&message=Halo",
      { "sec-fetch-site": "same-origin" },
    );
    const res2 = await validatePublicPostRequest(forgedSnake, {
      tenantHost: TEST_HOST,
      schema: PublicLeadSubmitRequestSchema,
    });
    expect(res2).toMatchObject({
      ok: false,
      status: 422,
      code: "FORGED_TENANT_FIELD",
    });

    // Legitimate payload with spoofed X-Tenant-ID / X-Forwarded-Host headers still resolves ONLY tenantHost
    const validWithSpoofedHeaders = createJsonRequest(
      JSON.stringify({
        name: "Siti Rahma",
        phone: "6281234567890",
        message: "Mau konsultasi",
        honeypot: "",
      }),
      {
        "x-tenant-id": "01JTESTTENANTBETA000000002",
        "x-forwarded-host": "beta-klinik.situsku.click",
        "cf-connecting-ip": "203.0.113.5",
        "idempotency-key": "11111111-1111-4111-8111-111111111111",
      },
    );
    const res3 = await validatePublicPostRequest(validWithSpoofedHeaders, {
      tenantHost: TEST_HOST,
      schema: PublicLeadSubmitRequestSchema,
    });
    expect(res3.ok).toBe(true);
    if (res3.ok) {
      expect(res3.tenantHost).toBe(TEST_HOST);
      expect(res3.expectedOrigin).toBe(TEST_ORIGIN);
      expect(res3.clientIp).toBe("203.0.113.5");
      expect(res3.idempotencyKey).toBe("11111111-1111-4111-8111-111111111111");
      expect(res3.data.name).toBe("Siti Rahma");
    }
  });

  it("rejects malformed syntax, invalid UTF-8, unsupported media types, control chars, and filled honeypots", async () => {
    // 415 unsupported content type (with valid Origin)
    const badCt = new Request(`${TEST_ORIGIN}/api/leads`, {
      method: "POST",
      headers: { "content-type": "text/plain", origin: TEST_ORIGIN },
      body: "hello",
    });
    expect(
      await validatePublicPostRequest(badCt, {
        tenantHost: TEST_HOST,
        allowedContentTypes: PUBLIC_LEAD_ALLOWED_CONTENT_TYPES,
      }),
    ).toMatchObject({ ok: false, status: 415, code: "UNSUPPORTED_MEDIA_TYPE" });

    // 400 malformed JSON
    expect(
      await validatePublicPostRequest(createJsonRequest("{bad json"), { tenantHost: TEST_HOST }),
    ).toMatchObject({ ok: false, status: 400, code: "MALFORMED_SYNTAX" });

    // 400 invalid UTF-8 bytes in JSON
    expect(
      await validatePublicPostRequest(
        createJsonRequest(new Uint8Array([0x7b, 0xff, 0xfe, 0x7d])),
        { tenantHost: TEST_HOST },
      ),
    ).toMatchObject({ ok: false, status: 400, code: "INVALID_ENCODING" });

    // 400 invalid percent-encoding & invalid UTF-8 in form-urlencoded
    expect(
      await validatePublicPostRequest(createFormRequest("name=%ZZ"), { tenantHost: TEST_HOST }),
    ).toMatchObject({ ok: false, status: 400, code: "MALFORMED_SYNTAX" });
    expect(
      await validatePublicPostRequest(createFormRequest("name=%FF%FE"), { tenantHost: TEST_HOST }),
    ).toMatchObject({ ok: false, status: 400, code: "INVALID_ENCODING" });

    // 422 control characters (NUL / BEL) while multiline \n is allowed
    expect(
      await validatePublicPostRequest(
        createJsonRequest(JSON.stringify({ name: "Budi\u0000", message: "Hi" })),
        { tenantHost: TEST_HOST },
      ),
    ).toMatchObject({ ok: false, status: 422, code: "CONTROL_CHARACTERS" });

    const multilineOk = await validatePublicPostRequest(
      createJsonRequest(
        JSON.stringify({
          name: "Budi",
          phone: "6281234567890",
          message: "Baris 1\nBaris 2\tinfo",
        }),
      ),
      { tenantHost: TEST_HOST, schema: PublicLeadSubmitRequestSchema },
    );
    expect(multilineOk.ok).toBe(true);

    // 422 filled honeypot
    const botRes = await validatePublicPostRequest(
      createJsonRequest(
        JSON.stringify({
          name: "Bot",
          phone: "6281234567890",
          message: "Spam",
          honeypot: "http://spam.example",
        }),
      ),
      { tenantHost: TEST_HOST, schema: PublicLeadSubmitRequestSchema },
    );
    expect(botRes).toMatchObject({ ok: false, status: 422, code: "HONEYPOT_TRIGGERED" });

    if (!botRes.ok) {
      const httpResponse = createPublicInputErrorResponse(botRes, "req_test_001");
      expect(httpResponse.status).toBe(422);
      expect(httpResponse.headers.get("cache-control")).toBe("no-store");
      const parsedEnvelope = ApiErrorSchema.safeParse(await httpResponse.json());
      expect(parsedEnvelope.success).toBe(true);
    }
  });

  it("supports /api/events and /api/abuse-report schemas and content-type presets", async () => {
    const eventReq = new Request(`${TEST_ORIGIN}/api/events`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: TEST_ORIGIN,
      },
      body: JSON.stringify({
        eventId: "22222222-2222-4222-8222-222222222222",
        eventName: "wa_click",
        path: "/layanan/konsultasi",
      }),
    });
    const eventRes = await validatePublicPostRequest(eventReq, {
      tenantHost: TEST_HOST,
      allowedContentTypes: PUBLIC_EVENT_ALLOWED_CONTENT_TYPES,
      schema: PublicEventIngestRequestSchema,
      honeypotField: null,
    });
    expect(eventRes.ok).toBe(true);

    const abuseReq = new Request(`${TEST_ORIGIN}/api/abuse-report`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: TEST_ORIGIN,
      },
      body: JSON.stringify({
        category: "spam",
        reportedPath: "/kontak",
        description: "Laporan penyalahgunaan formulir publik untuk pengujian.",
        turnstileToken: "test-token-abc",
      }),
    });
    const abuseRes = await validatePublicPostRequest(abuseReq, {
      tenantHost: TEST_HOST,
      allowedContentTypes: PUBLIC_ABUSE_REPORT_ALLOWED_CONTENT_TYPES,
      schema: PublicAbuseReportRequestSchema,
    });
    expect(abuseRes.ok).toBe(true);
  });
});

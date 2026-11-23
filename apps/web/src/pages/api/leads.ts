import * as cfWorkers from "cloudflare:workers";
import { normalizeHost, PLATFORM_HOSTS, type SurfaceKind } from "@punyasitus/core";
import {
  createLocalMailSink,
  escapeHtml,
  resolveEmailPort,
  type CloudflareSendEmailBinding,
  type EmailPort,
} from "@punyasitus/core/email/index";
import {
  isHoneypotTriggered,
  stripTurnstileAndHoneypotFields,
  verifyTurnstileGuard,
} from "@punyasitus/core/security/turnstile";
import { isEmailSuppressed } from "@punyasitus/db/email/index";
import { executeIdempotentLeadWrite, hashLeadPayload } from "@punyasitus/db/lead-dedup/index";
import {
  buildNewLeadOwnerNotificationEmail,
  getLeadNotificationSettings,
  sanitizeSafeRelativePath,
  validatePublicLeadSubmission,
} from "@punyasitus/db/leads/index";
import {
  enforceLeadRateLimit,
  hashNetworkIdentifier,
  type LeadRateLimitPolicy,
} from "@punyasitus/db/rate-limits/index";
import type { APIRoute } from "astro";
import {
  createPublicInputErrorResponse,
  DEFAULT_PUBLIC_POST_MAX_BYTES,
  PUBLIC_LEAD_ALLOWED_CONTENT_TYPES,
  validatePublicPostRequest,
} from "../../core/public-input.ts";
import type { TenantContext, TenantMiddlewareLocals } from "../../core/tenant.ts";

/**
 * Public host-scoped visitor lead capture endpoint (`POST /api/leads`;
 * TASK-021, REQ-031, REQ-038, REQ-039).
 *
 * Security & durability invariants:
 * - Served ONLY on verified tenant hosts (returns neutral `404` on marketing/app/console/unknown hosts).
 * - Tenant scope comes EXCLUSIVELY from the verified host (`TASK-002`); client `tenantId`,
 *   `X-Tenant-ID`, and `X-Forwarded-Host` are ignored or rejected (`422 FORGED_TENANT_FIELD`).
 * - Supports BOTH `application/json` (progressive enhancement) AND `application/x-www-form-urlencoded`
 *   / `multipart/form-data` (100% no-JS HTML form POST with `303 See Other` PRG redirect).
 * - Enforces:
 *   1. Exact Origin / Sec-Fetch-Site matrix & 16 KiB body cap (`validatePublicPostRequest`)
 *   2. Honeypot trap (`honeypot`, `hp_website`, `_hp_field`, `website_url`) -> silent drop without storing or emailing
 *   3. Cloudflare Turnstile verification (`action: "lead_submit"`, fail-closed outside local/test)
 *   4. Strict field validation + explicit privacy consent acknowledgement
 *   5. Anonymous rate limiting (`5/min` per IP+tenant, `100/hr` per tenant -> `429 RATE_LIMITED`)
 *   6. Atomic idempotent persistence (`lead_dedup` + `leads` -> replay returns durable success without duplicate)
 *   7. One PII-free owner email per newly persisted lead (switchable OFF; failure NEVER blocks persistence)
 *   8. Storage outage returns `503 SERVICE_UNAVAILABLE` cleanly without false success
 */

export interface PublicLeadTenantScope {
  readonly id: string;
  readonly handle: string;
  readonly name: string;
  readonly host: string;
  readonly status?: TenantContext["status"];
  readonly timeZone?: string;
}

export interface HandlePublicLeadPostDeps {
  readonly surface: SurfaceKind;
  readonly tenant: PublicLeadTenantScope | null;
  readonly tenantDb: D1Database | null;
  readonly platformDb?: D1Database | null;
  readonly emailPort?: EmailPort | null;
  readonly ownerEmail?: string | null;
  readonly appOrigin?: string;
  readonly appEnv?: string;
  readonly turnstileSecretKey?: string | null;
  readonly enforceTurnstileWhenUnconfigured?: boolean;
  readonly turnstileFetchFn?: typeof fetch;
  readonly rateLimitSalt: string | undefined;
  readonly isLocalLoopback?: boolean;
  readonly expectedOrigin?: string;
  readonly rateLimitPolicy?: LeadRateLimitPolicy;
  readonly nowMs?: number;
  readonly requestId?: string;
  /** Non-blocking background scheduler (e.g. Cloudflare `ctx.waitUntil`) so email dispatch never stalls visitor responses. */
  readonly waitUntil?: (promise: Promise<unknown>) => void;
  /** Bounded timeout for owner notification email delivery (default 5000ms). */
  readonly emailTimeoutMs?: number;
}

const DEFAULT_EMAIL_TIMEOUT_MS = 5_000;
const NOJS_DOUBLE_SUBMIT_WINDOW_MS = 30_000;

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex, nofollow",
} as const;

const CONFIRMATION_MESSAGE_ID =
  "Terima kasih! Pesan Anda telah kami terima. Tim kami akan segera menghubungi Anda.";

const SERVING_TENANT_STATUSES = new Set(["trial", "active", "grace", "locked"]);

function createRequestId(): string {
  try {
    return `req_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  } catch {
    return `req_${Date.now().toString(36)}`;
  }
}

function readOptionalEnvString(key: string): string | undefined {
  const bag = cfWorkers.env as unknown as Record<string, unknown>;
  const value = bag[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function createApiErrorJsonResponse(
  status: number,
  code: string,
  message: string,
  requestId: string,
  fields?: readonly { readonly field: string; readonly code: string; readonly message: string }[],
  extraHeaders?: Record<string, string>,
): Response {
  return Response.json(
    {
      error: {
        code,
        message,
        ...(fields && fields.length > 0 ? { fields } : {}),
      },
      requestId,
    },
    {
      status,
      headers: {
        ...NO_STORE_HEADERS,
        ...(status === 503 ? { "Retry-After": "60" } : {}),
        ...extraHeaders,
      },
    },
  );
}

function isFormRequest(request: Request): boolean {
  const ct = (request.headers.get("content-type") ?? "").toLowerCase();
  return (
    ct.includes("application/x-www-form-urlencoded") ||
    ct.includes("multipart/form-data")
  );
}

function buildPrgRedirectResponse(
  returnTo: string,
  params: Readonly<Record<string, string>>,
): Response {
  const safePath = sanitizeSafeRelativePath(returnTo) ?? "/";
  const search = new URLSearchParams(params);
  return new Response(null, {
    status: 303,
    headers: {
      Location: `${safePath}?${search.toString()}#formulir-kontak`,
      ...NO_STORE_HEADERS,
    },
  });
}

function buildFormServiceUnavailableHtml(message: string, returnTo: string): Response {
  const safePath = sanitizeSafeRelativePath(returnTo) ?? "/";
  const escapedHref = `${escapeHtml(safePath)}#formulir-kontak`;
  const escapedMsg = escapeHtml(message);
  const html = `<!doctype html><html lang="id"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><meta name="robots" content="noindex, nofollow"/><title>Layanan Sementara Tidak Tersedia</title></head><body style="font-family:system-ui,sans-serif;max-width:36rem;margin:3rem auto;padding:0 1rem;color:#0f172a;line-height:1.6;"><main><h1>Pesan Belum Dapat Disimpan</h1><p>${escapedMsg}</p><p><a href="${escapedHref}">Kembali ke formulir kontak</a></p></main></body></html>`;
  return new Response(html, {
    status: 503,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Retry-After": "60",
      ...NO_STORE_HEADERS,
    },
  });
}

function isAnyHoneypotPopulated(payload: Readonly<Record<string, unknown>>): boolean {
  if (isHoneypotTriggered(payload)) return true;
  if (Object.prototype.hasOwnProperty.call(payload, "honeypot")) {
    const val = payload.honeypot;
    if (typeof val === "string" && val.trim().length > 0) return true;
    if (typeof val === "number" || typeof val === "boolean") return true;
    if (Array.isArray(val) && val.length > 0) return true;
  }
  return false;
}

function stripAllAntiBotFields(
  payload: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const cleaned = stripTurnstileAndHoneypotFields(payload);
  delete cleaned.honeypot;
  return cleaned;
}

function resolveReturnPath(payload: Readonly<Record<string, unknown>>, request: Request): string {
  const fromBody = sanitizeSafeRelativePath(payload.returnTo) ?? sanitizeSafeRelativePath(payload.sourcePath);
  if (fromBody) return fromBody;
  const referer = request.headers.get("referer");
  if (referer) {
    try {
      const parsed = new URL(referer);
      const fromReferer = sanitizeSafeRelativePath(parsed.pathname);
      if (fromReferer) return fromReferer;
    } catch {
      // ignore malformed referer
    }
  }
  return "/";
}

async function resolveOwnerEmailAddress(
  deps: HandlePublicLeadPostDeps,
  tenantId: string,
): Promise<string | null> {
  if (deps.ownerEmail !== undefined) {
    const trimmed = deps.ownerEmail?.trim().toLowerCase() ?? "";
    return trimmed.length > 0 ? trimmed : null;
  }
  if (!deps.platformDb) return null;
  try {
    const row = await deps.platformDb
      .prepare(
        `SELECT u.email AS email
         FROM tenants t
         INNER JOIN members m
           ON m.organization_id = t.organization_id
          AND m.role = 'owner'
         INNER JOIN users u
           ON u.id = m.user_id
         WHERE t.id = ?
         ORDER BY m.created_at ASC
         LIMIT 1`,
      )
      .bind(tenantId)
      .first<{ readonly email: string }>();
    const email = row?.email?.trim().toLowerCase() ?? "";
    return email.length > 0 ? email : null;
  } catch {
    return null;
  }
}

async function recordLeadSubmitMetricBestEffort(
  tenantDb: D1Database,
  pagePath: string | null,
  nowMs: number,
  timeZone = "Asia/Jakarta",
): Promise<void> {
  try {
    const day = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(nowMs));
    const safePath = sanitizeSafeRelativePath(pagePath) ?? "/";
    await tenantDb
      .prepare(
        `INSERT INTO analytics_daily (day, path, pageviews, unique_visitors, wa_clicks, external_clicks, lead_submits, updated_at)
         VALUES (?, ?, 0, 0, 0, 0, 1, ?)
         ON CONFLICT(day, path) DO UPDATE SET
           lead_submits = analytics_daily.lead_submits + 1,
           updated_at = excluded.updated_at`,
      )
      .bind(day, safePath, nowMs)
      .run();
  } catch {
    // Non-blocking auxiliary counter update
  }
}

async function sendEmailBounded(
  emailPort: EmailPort,
  request: Parameters<EmailPort["send"]>[0],
  timeoutMs: number,
): Promise<void> {
  const boundedMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.trunc(timeoutMs) : DEFAULT_EMAIL_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      emailPort.send(request),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, boundedMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function dispatchOwnerLeadNotificationBestEffort(params: {
  readonly deps: HandlePublicLeadPostDeps;
  readonly tenant: PublicLeadTenantScope;
  readonly tenantDb: D1Database;
  readonly leadId: number;
}): Promise<void> {
  try {
    if (!params.deps.emailPort) return;

    const notifSettings = await getLeadNotificationSettings(params.tenantDb);
    if (!notifSettings.emailEnabled) return;

    const ownerEmail = await resolveOwnerEmailAddress(params.deps, params.tenant.id);
    if (!ownerEmail) return;

    if (params.deps.platformDb) {
      try {
        const suppressed = await isEmailSuppressed(params.deps.platformDb, ownerEmail);
        if (suppressed) return;
      } catch {
        // If suppression table is unavailable in a minimal test, continue safely
      }
    }

    const platformDomain =
      normalizeHost(readOptionalEnvString("PLATFORM_DOMAIN")) ?? PLATFORM_HOSTS.marketing;
    const appOrigin = params.deps.appOrigin?.trim() || `https://app.${platformDomain}`;

    const emailRequest = buildNewLeadOwnerNotificationEmail({
      tenantId: params.tenant.id,
      tenantName: params.tenant.name,
      tenantHandle: params.tenant.handle,
      leadId: params.leadId,
      ownerEmail,
      appOrigin,
    });

    await sendEmailBounded(
      params.deps.emailPort,
      emailRequest,
      params.deps.emailTimeoutMs ?? DEFAULT_EMAIL_TIMEOUT_MS,
    );
  } catch {
    // REQ-031 invariant: email notification failure NEVER blocks or rolls back lead persistence!
  }
}

/**
 * Pure, testable handler for `POST /api/leads` shared by the Astro API route
 * and `workerd` integration tests.
 */
export async function handlePublicLeadPost(
  request: Request,
  deps: HandlePublicLeadPostDeps,
): Promise<Response> {
  const requestId = deps.requestId ?? createRequestId();

  // 1. Strict tenant-host isolation (NEVER serve on marketing/app/console/unknown hosts).
  const isTenantSurface = deps.surface === "tenant";
  const isLocalHarnessWithTenant = Boolean(deps.isLocalLoopback && deps.tenant && deps.tenantDb);
  if ((!isTenantSurface && !isLocalHarnessWithTenant) || !deps.tenant) {
    return createApiErrorJsonResponse(404, "NOT_FOUND", "Halaman tidak ditemukan.", requestId);
  }

  // Reject non-serving tenant lifecycle states cleanly.
  if (deps.tenant.status && !SERVING_TENANT_STATUSES.has(deps.tenant.status)) {
    if (deps.tenant.status === "suspended") {
      return createApiErrorJsonResponse(
        503,
        "SITE_SUSPENDED",
        "Situs sedang dalam perbaikan sementara.",
        requestId,
      );
    }
    if (deps.tenant.status === "recovery") {
      return createApiErrorJsonResponse(
        503,
        "SITE_RECOVERY",
        "Situs sedang dalam pemeliharaan.",
        requestId,
      );
    }
    return createApiErrorJsonResponse(404, "NOT_FOUND", "Halaman tidak ditemukan.", requestId);
  }

  // 2. Origin/Sec-Fetch-Site matrix, Content-Type, 16 KiB body cap, UTF-8, forged tenantId & control chars.
  // Honeypot is handled right below as a silent drop without storing.
  const inputCheck = await validatePublicPostRequest(request, {
    tenantHost: deps.tenant.host,
    expectedOrigin: deps.expectedOrigin,
    allowedContentTypes: PUBLIC_LEAD_ALLOWED_CONTENT_TYPES,
    maxBytes: DEFAULT_PUBLIC_POST_MAX_BYTES,
    honeypotField: null,
  });

  if (!inputCheck.ok) {
    return createPublicInputErrorResponse(inputCheck, requestId);
  }

  const submissionMode = inputCheck.submissionMode;
  const returnPath = resolveReturnPath(inputCheck.rawPayload, request);

  // 3. Honeypot check: silently drop bot submissions WITHOUT storing and WITHOUT emailing.
  if (isAnyHoneypotPopulated(inputCheck.rawPayload)) {
    if (submissionMode === "form") {
      return buildPrgRedirectResponse(returnPath, { leadStatus: "accepted" });
    }
    return Response.json(
      {
        leadNumber: 0,
        status: "accepted",
        confirmationMessage: CONFIRMATION_MESSAGE_ID,
      },
      {
        status: 201,
        headers: NO_STORE_HEADERS,
      },
    );
  }

  // 4. Cloudflare Turnstile verification (action: "lead_submit", fail-closed outside local/test).
  const turnstileResult = await verifyTurnstileGuard({
    appEnv: deps.appEnv,
    secretKey: deps.turnstileSecretKey,
    request,
    body: inputCheck.rawPayload,
    remoteIp: inputCheck.clientIp,
    expectedAction: "lead_submit",
    expectedHostname: deps.tenant.host,
    enforceWhenUnconfigured: deps.enforceTurnstileWhenUnconfigured,
    fetchFn: deps.turnstileFetchFn,
  });

  if (!turnstileResult.ok) {
    if (submissionMode === "form") {
      return buildPrgRedirectResponse(returnPath, {
        leadStatus: "error",
        code: turnstileResult.code,
      });
    }
    return createApiErrorJsonResponse(
      turnstileResult.status,
      turnstileResult.code,
      turnstileResult.reason,
      requestId,
    );
  }

  // 5. Strip Turnstile/honeypot transport fields & strictly validate lead payload + privacy consent.
  const cleanedPayload = stripAllAntiBotFields(inputCheck.rawPayload);
  const validation = validatePublicLeadSubmission(cleanedPayload, {
    requirePrivacyConsent: true,
  });

  if (!validation.ok) {
    if (submissionMode === "form") {
      return buildPrgRedirectResponse(returnPath, {
        leadStatus: "error",
        code: "VALIDATION_ERROR",
      });
    }
    return createApiErrorJsonResponse(
      422,
      "VALIDATION_ERROR",
      validation.message,
      requestId,
      validation.fields,
    );
  }

  // 6. Fail-closed check for TenantStore & rate-limit salt (NEVER return false success on outage!).
  const rateLimitSalt = deps.rateLimitSalt?.trim();
  if (!deps.tenantDb || !rateLimitSalt) {
    const unavailableMsg = "Layanan penyimpanan pesan sementara tidak tersedia. Silakan coba lagi beberapa saat lagi.";
    if (submissionMode === "form") {
      return buildFormServiceUnavailableHtml(unavailableMsg, validation.data.returnTo ?? returnPath);
    }
    return createApiErrorJsonResponse(503, "SERVICE_UNAVAILABLE", unavailableMsg, requestId);
  }

  // 7. Anonymous per-IP+tenant & per-tenant hourly rate limiting (`429 RATE_LIMITED`).
  const nowMs = Math.floor(deps.nowMs ?? Date.now());
  const rateLimit = await enforceLeadRateLimit(deps.tenantDb, {
    tenantId: deps.tenant.id,
    clientIp: inputCheck.clientIp,
    salt: rateLimitSalt,
    nowMs,
    policy: deps.rateLimitPolicy,
  });

  if (!rateLimit.ok) {
    if (submissionMode === "form") {
      return buildFormServiceUnavailableHtml(rateLimit.message, validation.data.returnTo ?? returnPath);
    }
    return createApiErrorJsonResponse(503, "SERVICE_UNAVAILABLE", rateLimit.message, requestId);
  }

  if (!rateLimit.allowed) {
    if (submissionMode === "form") {
      return buildPrgRedirectResponse(validation.data.returnTo ?? returnPath, {
        leadStatus: "error",
        code: "RATE_LIMITED",
      });
    }
    return createApiErrorJsonResponse(
      429,
      "RATE_LIMITED",
      rateLimit.message,
      requestId,
      undefined,
      { "Retry-After": String(rateLimit.retryAfterSeconds) },
    );
  }

  // 8. Atomic idempotent persistence in `TenantStore` (`lead_dedup` + `leads`).
  //    - Caller-supplied `Idempotency-Key` header or non-empty body `idempotencyKey`: strict replay/409 semantics.
  //    - Omitted/empty key (e.g. No-JS cached HTML form): deterministic 30s double-submit bucket key
  //      derived from `(tenantId, ipHash, canonicalPayload)` so concurrent visitors served identical cached HTML
  //      NEVER collide with 409, while rapid accidental double-clicks by the same visitor still deduplicate!
  const explicitIdempotencyKey =
    inputCheck.idempotencyKey ?? validation.data.idempotencyKey;
  let idempotencyKey: string;
  if (explicitIdempotencyKey) {
    idempotencyKey = explicitIdempotencyKey;
  } else {
    const bucket30s = Math.floor(nowMs / NOJS_DOUBLE_SUBMIT_WINDOW_MS);
    const ipHash = await hashNetworkIdentifier(inputCheck.clientIp, rateLimitSalt);
    const fingerprint = await hashLeadPayload({
      tenantId: deps.tenant.id,
      ipHash,
      payload: validation.data.canonicalPayload,
    });
    idempotencyKey = `nojs:${bucket30s}:${fingerprint.slice(0, 48)}`;
  }

  const writeResult = await executeIdempotentLeadWrite(deps.tenantDb, {
    idempotencyKey,
    lead: validation.data.lead,
    payload: validation.data.canonicalPayload,
    nowMs,
  });

  if (!writeResult.ok) {
    if (writeResult.kind === "invalid_key") {
      if (submissionMode === "form") {
        return buildPrgRedirectResponse(validation.data.returnTo ?? returnPath, {
          leadStatus: "error",
          code: "VALIDATION_ERROR",
        });
      }
      return createApiErrorJsonResponse(422, "VALIDATION_ERROR", writeResult.message, requestId, [
        { field: "idempotencyKey", code: "INVALID_IDEMPOTENCY_KEY", message: writeResult.message },
      ]);
    }
    if (submissionMode === "form") {
      return buildFormServiceUnavailableHtml(writeResult.message, validation.data.returnTo ?? returnPath);
    }
    return createApiErrorJsonResponse(503, "SERVICE_UNAVAILABLE", writeResult.message, requestId);
  }

  if (writeResult.kind === "conflict") {
    if (submissionMode === "form") {
      return buildPrgRedirectResponse(validation.data.returnTo ?? returnPath, {
        leadStatus: "error",
        code: "IDEMPOTENCY_CONFLICT",
      });
    }
    return createApiErrorJsonResponse(409, "IDEMPOTENCY_CONFLICT", writeResult.message, requestId);
  }

  // 9. Newly persisted lead ONLY (NEVER on idempotent replay):
  //    dispatch first-party daily counter & ONE PII-free owner email off the critical path via `waitUntil`
  //    so slow/hung mail providers never stall the visitor's 201/303 response.
  if (writeResult.kind === "created") {
    const postCommitWork = Promise.all([
      recordLeadSubmitMetricBestEffort(
        deps.tenantDb,
        validation.data.lead.pagePath ?? null,
        nowMs,
        deps.tenant.timeZone,
      ),
      dispatchOwnerLeadNotificationBestEffort({
        deps,
        tenant: deps.tenant,
        tenantDb: deps.tenantDb,
        leadId: writeResult.leadId,
      }),
    ]).then(() => undefined);

    if (deps.waitUntil) {
      deps.waitUntil(postCommitWork);
    } else {
      await postCommitWork;
    }
  }

  // 10. Durable response: PRG `303 See Other` for HTML forms; `201 Created` JSON for JS clients.
  if (submissionMode === "form") {
    return buildPrgRedirectResponse(validation.data.returnTo ?? returnPath, {
      leadStatus: "accepted",
      leadNumber: String(writeResult.leadId),
    });
  }

  return Response.json(
    {
      leadNumber: writeResult.leadId,
      status: "accepted",
      confirmationMessage: CONFIRMATION_MESSAGE_ID,
    },
    {
      status: 201,
      headers: NO_STORE_HEADERS,
    },
  );
}

function readTenantLocals(locals: unknown): TenantMiddlewareLocals {
  const bag = (locals ?? {}) as Partial<TenantMiddlewareLocals>;
  return {
    surface: bag.surface ?? "unknown",
    host: bag.host ?? "",
    isLocalLoopback: Boolean(bag.isLocalLoopback),
    tenant: bag.tenant ?? null,
    tenantDb: bag.tenantDb ?? null,
  };
}

function resolveBackgroundWaitUntil(locals: unknown): ((promise: Promise<unknown>) => void) | undefined {
  const bag = locals as {
    readonly cfContext?: { readonly waitUntil?: (p: Promise<unknown>) => void };
    readonly runtime?: { readonly ctx?: { readonly waitUntil?: (p: Promise<unknown>) => void } };
  } | null;
  if (bag?.cfContext && typeof bag.cfContext.waitUntil === "function") {
    return bag.cfContext.waitUntil.bind(bag.cfContext);
  }
  if (bag?.runtime?.ctx && typeof bag.runtime.ctx.waitUntil === "function") {
    return bag.runtime.ctx.waitUntil.bind(bag.runtime.ctx);
  }
  const maybeGlobalWaitUntil = (cfWorkers as unknown as {
    readonly waitUntil?: (p: Promise<unknown>) => void;
  }).waitUntil;
  if (typeof maybeGlobalWaitUntil === "function") {
    return (promise) => {
      try {
        maybeGlobalWaitUntil(promise);
      } catch {
        // Ignore if invoked outside an active Cloudflare request context
      }
    };
  }
  return undefined;
}

export const POST: APIRoute = async ({ request, locals }) => {
  const tenantLocals = readTenantLocals(locals);
  const runtimeEnv = cfWorkers.env;
  const configuredSalt = readOptionalEnvString("RATE_LIMIT_SALT");
  const rateLimitSalt =
    configuredSalt ?? (runtimeEnv.APP_ENV === "local" ? "local-dev-lead-rate-limit-salt" : undefined);

  const emailPort: EmailPort | null =
    runtimeEnv.APP_ENV === "local" || runtimeEnv.APP_ENV === "test"
      ? createLocalMailSink()
      : resolveEmailPort({
          cloudflareBinding:
            (runtimeEnv as unknown as { readonly EMAIL?: CloudflareSendEmailBinding | null }).EMAIL ?? null,
        });

  return handlePublicLeadPost(request, {
    surface: tenantLocals.surface,
    tenant: tenantLocals.tenant
      ? {
          id: tenantLocals.tenant.id,
          handle: tenantLocals.tenant.handle,
          name: tenantLocals.tenant.name,
          host: tenantLocals.tenant.host,
          status: tenantLocals.tenant.status,
        }
      : null,
    tenantDb: tenantLocals.tenantDb,
    platformDb: runtimeEnv.PLATFORM_DB ?? null,
    emailPort,
    appEnv: runtimeEnv.APP_ENV,
    turnstileSecretKey: readOptionalEnvString("TURNSTILE_SECRET_KEY"),
    rateLimitSalt,
    isLocalLoopback: tenantLocals.isLocalLoopback,
    waitUntil: resolveBackgroundWaitUntil(locals),
  });
};

export const ALL: APIRoute = async ({ request, locals }) => {
  const tenantLocals = readTenantLocals(locals);
  const requestId = createRequestId();
  if (tenantLocals.surface !== "tenant" && !tenantLocals.isLocalLoopback) {
    return createApiErrorJsonResponse(404, "NOT_FOUND", "Halaman tidak ditemukan.", requestId);
  }
  if (isFormRequest(request)) {
    return createApiErrorJsonResponse(
      405,
      "BAD_REQUEST",
      "Metode HTTP tidak diizinkan untuk formulir kontak.",
      requestId,
      undefined,
      { Allow: "POST" },
    );
  }
  return createApiErrorJsonResponse(
    405,
    "BAD_REQUEST",
    "Metode HTTP tidak diizinkan untuk endpoint ini.",
    requestId,
    undefined,
    { Allow: "POST" },
  );
};

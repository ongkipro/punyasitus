import * as cfWorkers from "cloudflare:workers";
import type { SurfaceKind } from "@punyasitus/core";
import { escapeHtml } from "@punyasitus/core/email/index";
import {
  isHoneypotTriggered,
  stripTurnstileAndHoneypotFields,
  verifyTurnstileGuard,
} from "@punyasitus/core/security/turnstile";
import {
  ABUSE_CATEGORIES,
  ABUSE_CATEGORY_LABELS_ID,
  createAbuseReport,
  enforceAbuseReportRateLimit,
  normalizeReportedPath,
  validatePublicAbuseReportInput,
} from "@punyasitus/db/abuse/index";
import { generatePlatformAuditId } from "@punyasitus/db/platform/audit";
import type { AbuseReportRateLimitPolicy } from "@punyasitus/db/rate-limits/index";
import type { APIRoute } from "astro";
import {
  createPublicInputErrorResponse,
  DEFAULT_PUBLIC_POST_MAX_BYTES,
  PUBLIC_ABUSE_REPORT_ALLOWED_CONTENT_TYPES,
  validatePublicPostRequest,
} from "../../core/public-input.ts";
import type { TenantContext, TenantMiddlewareLocals } from "../../core/tenant.ts";

/**
 * Public host-scoped abuse reporting endpoint (`POST /api/abuse-report` & HTML form `GET /api/abuse-report`;
 * REQ-094, REQ-038, REQ-039, REQ-090; PLAN §6, §19.5; TASK-094).
 *
 * Security invariants:
 * - Served ONLY on verified tenant hosts (returns neutral `404` on marketing/app/console/unknown hosts).
 * - Tenant scope comes EXCLUSIVELY from the verified request host; forged `tenantId` / `tenant_id`
 *   / `organizationId` / `tenantHandle` fields are rejected with `422 FORGED_TENANT_FIELD`.
 * - Enforces:
 *   1. Exact Origin / Sec-Fetch-Site matrix & 16 KiB body cap (`validatePublicPostRequest`)
 *   2. Accessible honeypot check (`honeypot`, `hp_website`, `_hp_field`, `website_url`) -> silent synthetic acceptance without storing
 *   3. Cloudflare Turnstile verification (`action: "abuse_report"`, fail-closed outside local/test)
 *   4. Strict allowlisted payload validation & sanitization (`category`, `reportedPath`, `description`, optional `reporterEmail`)
 *   5. Fail-closed atomic D1 rate limiting (`5/min` per network+tenant, `50/hr` per tenant -> `429 RATE_LIMITED`)
 *   6. Zero enumeration & zero PII leakage in responses (`201 { reportId, status: "received" }` or `303` PRG redirect)
 */

export interface PublicAbuseTenantScope {
  readonly id: string;
  readonly handle: string;
  readonly name: string;
  readonly host: string;
  readonly status?: TenantContext["status"];
}

export interface HandlePublicAbusePostDeps {
  readonly surface: SurfaceKind;
  readonly tenant: PublicAbuseTenantScope | null;
  readonly platformDb: D1Database | null;
  readonly appEnv?: string;
  readonly turnstileSecretKey?: string | null;
  readonly turnstileSiteKey?: string | null;
  readonly enforceTurnstileWhenUnconfigured?: boolean;
  readonly turnstileFetchFn?: typeof fetch;
  readonly rateLimitSalt: string | undefined;
  readonly isLocalLoopback?: boolean;
  readonly expectedOrigin?: string;
  readonly rateLimitPolicy?: AbuseReportRateLimitPolicy;
  readonly nowMs?: number;
  readonly requestId?: string;
}

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex, nofollow",
} as const;

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

function buildPrgRedirect(
  targetPath: string,
  params: Readonly<Record<string, string>>,
): Response {
  const safeBase =
    targetPath.startsWith("/") && !targetPath.startsWith("//") && !targetPath.includes("\\")
      ? targetPath.split("?")[0]!.split("#")[0]!
      : "/api/abuse-report";
  const search = new URLSearchParams(params);
  return new Response(null, {
    status: 303,
    headers: {
      Location: `${safeBase}?${search.toString()}`,
      ...NO_STORE_HEADERS,
    },
  });
}

function renderPublicAbuseFormHtml(params: {
  readonly tenantName: string;
  readonly tenantHost: string;
  readonly initialPath: string;
  readonly statusQuery: string | null;
  readonly refQuery: string | null;
  readonly errorCodeQuery: string | null;
  readonly turnstileSiteKey?: string | null;
}): string {
  const escapedTenantName = escapeHtml(params.tenantName);
  const escapedHost = escapeHtml(params.tenantHost);
  const escapedPath = escapeHtml(params.initialPath);
  const isReceived = params.statusQuery === "received";
  const isError = params.statusQuery === "error";
  const safeRef =
    params.refQuery && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(params.refQuery) ? params.refQuery : null;

  const errorText =
    params.errorCodeQuery === "RATE_LIMITED"
      ? "Terlalu banyak laporan dikirim dalam waktu singkat. Silakan tunggu beberapa saat lalu coba lagi."
      : params.errorCodeQuery === "TURNSTILE_REQUIRED" ||
          params.errorCodeQuery === "TURNSTILE_INVALID"
        ? "Verifikasi keamanan Turnstile gagal atau belum diselesaikan. Muat ulang halaman lalu coba lagi."
        : params.errorCodeQuery === "SERVICE_UNAVAILABLE"
          ? "Layanan pelaporan sementara tidak tersedia. Silakan coba lagi nanti."
          : "Periksa kembali kategori, path halaman, dan uraian laporan minimal 10 karakter.";

  const categoryOptions = ABUSE_CATEGORIES.map(
    (cat) =>
      `<option value="${escapeHtml(cat)}">${escapeHtml(ABUSE_CATEGORY_LABELS_ID[cat])}</option>`,
  ).join("");

  const turnstileMarkup = params.turnstileSiteKey
    ? `<div class="field"><div class="cf-turnstile" data-sitekey="${escapeHtml(params.turnstileSiteKey)}" data-action="abuse_report"></div></div><script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>`
    : "";

  return `<!doctype html>
<html lang="id">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex, nofollow" />
  <link rel="icon" href="data:," />
  <title>Laporkan Penyalahgunaan — ${escapedTenantName}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #f8fafc;
      color: #0f172a;
      line-height: 1.55;
      padding: 20px 14px 40px;
    }
    .shell {
      max-width: 600px;
      margin: 0 auto;
      background: #ffffff;
      border: 1px solid #e2e8f0;
      border-radius: 12px;
      padding: 22px 18px;
      box-shadow: 0 1px 2px rgba(15, 23, 42, 0.05);
    }
    @media (min-width: 640px) {
      body { padding: 40px 24px; }
      .shell { padding: 32px; }
    }
    h1 { font-size: 1.375rem; line-height: 1.25; margin: 0 0 8px; letter-spacing: -0.02em; }
    .subtitle { margin: 0 0 20px; font-size: 0.9rem; color: #475569; }
    .host-pill {
      display: inline-block;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.8rem;
      background: #f1f5f9;
      border: 1px solid #cbd5e1;
      border-radius: 6px;
      padding: 2px 8px;
      color: #0f172a;
      word-break: break-all;
    }
    .alert {
      border-radius: 8px;
      padding: 12px 14px;
      margin-bottom: 18px;
      font-size: 0.875rem;
    }
    .alert-success { background: #ecfdf5; border: 1px solid #a7f3d0; color: #065f46; }
    .alert-error { background: #fef2f2; border: 1px solid #fecaca; color: #991b1b; }
    .field { margin-bottom: 16px; }
    label { display: block; font-size: 0.875rem; font-weight: 600; margin-bottom: 6px; color: #0f172a; }
    .hint { display: block; font-size: 0.78rem; color: #64748b; margin-top: 4px; }
    input[type="text"], input[type="email"], select, textarea {
      width: 100%;
      min-height: 44px;
      border: 1px solid #cbd5e1;
      border-radius: 8px;
      padding: 10px 12px;
      font: inherit;
      font-size: 0.9375rem;
      color: #0f172a;
      background: #ffffff;
    }
    textarea { min-height: 120px; resize: vertical; }
    input:focus-visible, select:focus-visible, textarea:focus-visible, button:focus-visible, a:focus-visible {
      outline: 2px solid #0f172a;
      outline-offset: 2px;
    }
    .hp-field {
      position: absolute;
      left: -9999px;
      width: 1px;
      height: 1px;
      overflow: hidden;
      opacity: 0;
      pointer-events: none;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      align-items: center;
      margin-top: 20px;
    }
    button[type="submit"] {
      min-height: 44px;
      padding: 10px 20px;
      border: 0;
      border-radius: 8px;
      background: #0f172a;
      color: #ffffff;
      font: inherit;
      font-size: 0.9375rem;
      font-weight: 600;
      cursor: pointer;
    }
    button[type="submit"]:hover { background: #1e293b; }
    .back-link {
      display: inline-flex;
      align-items: center;
      min-height: 44px;
      padding: 0 12px;
      font-size: 0.875rem;
      color: #334155;
      text-decoration: underline;
    }
    .footer-note {
      margin-top: 22px;
      padding-top: 14px;
      border-top: 1px solid #e2e8f0;
      font-size: 0.78rem;
      color: #64748b;
    }
  </style>
</head>
<body>
  <main class="shell" data-testid="public-abuse-report-page">
    <h1>Laporkan Penyalahgunaan Situs</h1>
    <p class="subtitle">
      Gunakan formulir ini untuk melaporkan dugaan penipuan, phishing, malware, atau konten melanggar pada situs
      <span class="host-pill">${escapedHost}</span>. Laporan akan ditinjau langsung oleh tim moderasi PunyaSitus.
    </p>

    ${
      isReceived
        ? `<div class="alert alert-success" role="status" data-testid="abuse-report-success">
            <strong>Laporan Anda telah diterima.</strong>
            ${safeRef ? ` Nomor referensi: <code>${escapeHtml(safeRef)}</code>.` : ""}
            Tim moderasi akan meninjau laporan ini secepatnya.
          </div>`
        : ""
    }

    ${
      isError
        ? `<div class="alert alert-error" role="alert" data-testid="abuse-report-error">
            <strong>Laporan belum dapat dikirim.</strong> ${escapeHtml(errorText)}
          </div>`
        : ""
    }

    <form method="post" action="/api/abuse-report" data-testid="public-abuse-report-form">
      <input type="hidden" name="returnTo" value="/api/abuse-report" />

      <div class="hp-field" aria-hidden="true">
        <label for="hp_website">Situs Web (biarkan kosong)</label>
        <input id="hp_website" name="hp_website" type="text" tabindex="-1" autocomplete="off" value="" />
      </div>

      <div class="field">
        <label for="reportedPath">Halaman yang Dilaporkan</label>
        <input
          id="reportedPath"
          name="reportedPath"
          type="text"
          required
          maxlength="200"
          value="${escapedPath}"
          placeholder="/contoh-halaman"
          data-testid="abuse-reported-path"
        />
        <span class="hint">Masukkan jalur halaman yang dimulai dengan <code>/</code> (tanpa parameter query).</span>
      </div>

      <div class="field">
        <label for="category">Kategori Pelanggaran</label>
        <select id="category" name="category" required data-testid="abuse-category">
          ${categoryOptions}
        </select>
      </div>

      <div class="field">
        <label for="description">Uraian Laporan</label>
        <textarea
          id="description"
          name="description"
          required
          minlength="10"
          maxlength="2000"
          placeholder="Jelaskan dugaan pelanggaran secara jelas dan faktual (minimal 10 karakter)..."
          data-testid="abuse-description"
        ></textarea>
        <span class="hint">Jangan sertakan kata sandi, OTP, atau data sensitif pribadi.</span>
      </div>

      <div class="field">
        <label for="reporterEmail">Email Pelapor (Opsional)</label>
        <input
          id="reporterEmail"
          name="reporterEmail"
          type="email"
          maxlength="254"
          placeholder="nama@contoh.com"
          data-testid="abuse-reporter-email"
        />
        <span class="hint">Opsional. Email pelapor tidak pernah dibagikan kepada pemilik situs terlapor.</span>
      </div>

      ${turnstileMarkup}

      <div class="actions">
        <button type="submit" data-testid="abuse-submit-btn">Kirim Laporan</button>
        <a href="/" class="back-link">Kembali ke Situs</a>
      </div>
    </form>

    <p class="footer-note">
      Dilindungi oleh verifikasi keamanan dan pembatasan laju. Semua tindakan moderasi dicatat secara teraudit.
    </p>
  </main>
</body>
</html>`;
}

/**
 * Pure, testable handler for `POST /api/abuse-report` (REQ-094).
 */
export async function handlePublicAbuseReportPost(
  request: Request,
  deps: HandlePublicAbusePostDeps,
): Promise<Response> {
  const requestId = deps.requestId ?? createRequestId();

  // 1. Strict tenant-host isolation (NEVER serve on marketing/app/console/unknown hosts).
  const isTenantSurface = deps.surface === "tenant";
  const isLocalHarnessWithTenant = Boolean(
    deps.isLocalLoopback && deps.appEnv === "local" && deps.tenant,
  );
  if ((!isTenantSurface && !isLocalHarnessWithTenant) || !deps.tenant) {
    return createApiErrorJsonResponse(404, "NOT_FOUND", "Halaman tidak ditemukan.", requestId);
  }

  // Only accept abuse reports for live/serving tenant states (zero enumeration on purged/provisioning)
  if (deps.tenant.status && !SERVING_TENANT_STATUSES.has(deps.tenant.status)) {
    if (deps.tenant.status === "suspended" || deps.tenant.status === "recovery") {
      return createApiErrorJsonResponse(
        503,
        "SERVICE_UNAVAILABLE",
        "Situs sedang tidak tersedia.",
        requestId,
      );
    }
    return createApiErrorJsonResponse(404, "NOT_FOUND", "Halaman tidak ditemukan.", requestId);
  }

  // 2. Origin/Sec-Fetch-Site matrix, Content-Type, 16 KiB cap, UTF-8, forged tenantId & control chars.
  const inputCheck = await validatePublicPostRequest(request, {
    tenantHost: deps.tenant.host,
    expectedOrigin: deps.expectedOrigin,
    allowedContentTypes: PUBLIC_ABUSE_REPORT_ALLOWED_CONTENT_TYPES,
    maxBytes: DEFAULT_PUBLIC_POST_MAX_BYTES,
    honeypotField: null,
  });

  if (!inputCheck.ok) {
    return createPublicInputErrorResponse(inputCheck, requestId);
  }

  const submissionMode = inputCheck.submissionMode;
  const nowMs = Math.floor(deps.nowMs ?? Date.now());
  const rawReturnTo =
    typeof inputCheck.rawPayload.returnTo === "string"
      ? inputCheck.rawPayload.returnTo
      : "/api/abuse-report";

  // 3. Honeypot check -> silent synthetic acceptance without storing (prevents bot probing)
  if (isAnyHoneypotPopulated(inputCheck.rawPayload)) {
    const syntheticId = generatePlatformAuditId(nowMs);
    if (submissionMode === "form") {
      return buildPrgRedirect(rawReturnTo, { status: "received", ref: syntheticId });
    }
    return Response.json(
      { reportId: syntheticId, status: "received" },
      { status: 201, headers: NO_STORE_HEADERS },
    );
  }

  // 4. Cloudflare Turnstile verification (`action: "abuse_report"`, fail-closed outside local/test)
  const turnstileResult = await verifyTurnstileGuard({
    appEnv: deps.appEnv,
    secretKey: deps.turnstileSecretKey,
    request,
    body: inputCheck.rawPayload,
    remoteIp: inputCheck.clientIp,
    expectedAction: "abuse_report",
    expectedHostname: deps.tenant.host,
    enforceWhenUnconfigured: deps.enforceTurnstileWhenUnconfigured,
    fetchFn: deps.turnstileFetchFn,
  });

  if (!turnstileResult.ok) {
    if (submissionMode === "form") {
      return buildPrgRedirect(rawReturnTo, {
        status: "error",
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

  // 5. Strip Turnstile & honeypot transport fields, then strictly validate & sanitize payload
  const cleanedPayload = stripAllAntiBotFields(inputCheck.rawPayload);
  const validation = validatePublicAbuseReportInput(cleanedPayload, deps.tenant.host);
  if (!validation.ok) {
    if (submissionMode === "form") {
      return buildPrgRedirect(rawReturnTo, {
        status: "error",
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

  // 6. Fail-closed rate limiting on PLATFORM_DB (`abuse_rate_limit_buckets`)
  const rateLimit = await enforceAbuseReportRateLimit(deps.platformDb, {
    tenantId: deps.tenant.id,
    clientIp: inputCheck.clientIp,
    salt: deps.rateLimitSalt,
    nowMs,
    policy: deps.rateLimitPolicy,
  });

  if (!rateLimit.ok) {
    if (submissionMode === "form") {
      return buildPrgRedirect(validation.data.returnTo ?? rawReturnTo, {
        status: "error",
        code: "SERVICE_UNAVAILABLE",
      });
    }
    return createApiErrorJsonResponse(503, "SERVICE_UNAVAILABLE", rateLimit.message, requestId);
  }

  if (!rateLimit.allowed) {
    if (submissionMode === "form") {
      return buildPrgRedirect(validation.data.returnTo ?? rawReturnTo, {
        status: "error",
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

  if (!deps.platformDb) {
    return createApiErrorJsonResponse(
      503,
      "SERVICE_UNAVAILABLE",
      "Layanan pelaporan sementara tidak tersedia.",
      requestId,
    );
  }

  // 7. Persist sanitized abuse report to `PLATFORM_DB.abuse_reports`
  try {
    const created = await createAbuseReport(deps.platformDb, {
      tenantId: deps.tenant.id,
      reportedHost: deps.tenant.host,
      reportedPath: validation.data.reportedPath,
      category: validation.data.category,
      description: validation.data.description,
      reporterEmail: validation.data.reporterEmail,
      nowMs,
    });

    if (submissionMode === "form") {
      return buildPrgRedirect(validation.data.returnTo ?? rawReturnTo, {
        status: "received",
        ref: created.reportId,
      });
    }

    // Zero enumeration / zero PII leakage response
    return Response.json(
      {
        reportId: created.reportId,
        status: created.status,
      },
      {
        status: 201,
        headers: NO_STORE_HEADERS,
      },
    );
  } catch {
    if (submissionMode === "form") {
      return buildPrgRedirect(validation.data.returnTo ?? rawReturnTo, {
        status: "error",
        code: "SERVICE_UNAVAILABLE",
      });
    }
    return createApiErrorJsonResponse(
      503,
      "SERVICE_UNAVAILABLE",
      "Gagal menyimpan laporan penyalahgunaan. Silakan coba lagi.",
      requestId,
    );
  }
}

/**
 * Pure, testable handler for `GET /api/abuse-report` (renders progressive-enhancement public HTML form
 * on verified tenant hosts when `Accept` includes `text/html`; returns `405` for JSON/API callers
 * and neutral `404` on non-tenant hosts).
 */
export function handlePublicAbuseReportGet(
  request: Request,
  deps: Pick<
    HandlePublicAbusePostDeps,
    "surface" | "tenant" | "appEnv" | "isLocalLoopback" | "turnstileSiteKey" | "requestId"
  >,
): Response {
  const requestId = deps.requestId ?? createRequestId();
  const isTenantSurface = deps.surface === "tenant";
  const isLocalHarnessWithTenant = Boolean(
    deps.isLocalLoopback && deps.appEnv === "local" && deps.tenant,
  );
  if ((!isTenantSurface && !isLocalHarnessWithTenant) || !deps.tenant) {
    return createApiErrorJsonResponse(404, "NOT_FOUND", "Halaman tidak ditemukan.", requestId);
  }

  const accept = (request.headers.get("accept") ?? "").toLowerCase();
  if (!accept.includes("text/html")) {
    return createApiErrorJsonResponse(
      405,
      "BAD_REQUEST",
      "Gunakan metode POST untuk mengirim laporan penyalahgunaan.",
      requestId,
      undefined,
      { Allow: "POST" },
    );
  }

  const url = new URL(request.url);
  const rawPathParam = url.searchParams.get("path") ?? "/";
  const normalized = normalizeReportedPath(rawPathParam, deps.tenant.host);
  const initialPath = normalized.ok ? normalized.path : "/";

  const html = renderPublicAbuseFormHtml({
    tenantName: deps.tenant.name,
    tenantHost: deps.tenant.host,
    initialPath,
    statusQuery: url.searchParams.get("status"),
    refQuery: url.searchParams.get("ref"),
    errorCodeQuery: url.searchParams.get("code"),
    turnstileSiteKey: deps.turnstileSiteKey,
  });

  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      ...NO_STORE_HEADERS,
    },
  });
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

async function resolveLocalLoopbackTenantFallback(
  request: Request,
  tenantLocals: TenantMiddlewareLocals,
  platformDb: D1Database | null,
  appEnv: string | undefined,
): Promise<{ readonly tenant: PublicAbuseTenantScope | null; readonly expectedOrigin?: string }> {
  if (tenantLocals.tenant) {
    return {
      tenant: {
        id: tenantLocals.tenant.id,
        handle: tenantLocals.tenant.handle,
        name: tenantLocals.tenant.name,
        host: tenantLocals.tenant.host,
        status: tenantLocals.tenant.status,
      },
    };
  }

  // Strictly local dev loopback harness fallback (NEVER active outside `APP_ENV === "local"` + loopback)
  if (appEnv !== "local" || !tenantLocals.isLocalLoopback || !platformDb) {
    return { tenant: null };
  }

  const reqUrl = new URL(request.url);
  const requestedHandle = reqUrl.searchParams.get("handle")?.trim().toLowerCase() ?? "";
  try {
    const row = requestedHandle
      ? await platformDb
          .prepare(
            `SELECT id, handle, name, status FROM tenants WHERE handle = ? AND status IN ('trial', 'active', 'grace', 'locked') LIMIT 1`,
          )
          .bind(requestedHandle)
          .first<{ readonly id: string; readonly handle: string; readonly name: string; readonly status: TenantContext["status"] }>()
      : await platformDb
          .prepare(
            `SELECT id, handle, name, status FROM tenants WHERE status IN ('trial', 'active', 'grace', 'locked') ORDER BY created_at DESC LIMIT 1`,
          )
          .first<{ readonly id: string; readonly handle: string; readonly name: string; readonly status: TenantContext["status"] }>();

    if (!row) return { tenant: null };
    const saasZone = readOptionalEnvString("SAAS_ZONE") ?? "situsku.click";
    return {
      tenant: {
        id: row.id,
        handle: row.handle,
        name: row.name,
        host: `${row.handle}.${saasZone}`,
        status: row.status,
      },
      expectedOrigin: reqUrl.origin,
    };
  } catch {
    return { tenant: null };
  }
}

export const GET: APIRoute = async ({ request, locals }) => {
  const tenantLocals = readTenantLocals(locals);
  const runtimeEnv = cfWorkers.env;
  const resolved = await resolveLocalLoopbackTenantFallback(
    request,
    tenantLocals,
    runtimeEnv.PLATFORM_DB ?? null,
    runtimeEnv.APP_ENV,
  );
  return handlePublicAbuseReportGet(request, {
    surface: tenantLocals.surface,
    tenant: resolved.tenant,
    appEnv: runtimeEnv.APP_ENV,
    isLocalLoopback: tenantLocals.isLocalLoopback,
    turnstileSiteKey: readOptionalEnvString("TURNSTILE_SITE_KEY"),
  });
};

export const POST: APIRoute = async ({ request, locals }) => {
  const tenantLocals = readTenantLocals(locals);
  const runtimeEnv = cfWorkers.env;
  const configuredSalt = readOptionalEnvString("RATE_LIMIT_SALT");
  const rateLimitSalt =
    configuredSalt ??
    (runtimeEnv.APP_ENV === "local" ? "local-dev-abuse-rate-limit-salt" : undefined);

  const resolved = await resolveLocalLoopbackTenantFallback(
    request,
    tenantLocals,
    runtimeEnv.PLATFORM_DB ?? null,
    runtimeEnv.APP_ENV,
  );

  return handlePublicAbuseReportPost(request, {
    surface: tenantLocals.surface,
    tenant: resolved.tenant,
    platformDb: runtimeEnv.PLATFORM_DB ?? null,
    appEnv: runtimeEnv.APP_ENV,
    turnstileSecretKey: readOptionalEnvString("TURNSTILE_SECRET_KEY"),
    rateLimitSalt,
    isLocalLoopback: tenantLocals.isLocalLoopback,
    expectedOrigin: resolved.expectedOrigin,
  });
};

export const ALL: APIRoute = async ({ locals }) => {
  const tenantLocals = readTenantLocals(locals);
  const requestId = createRequestId();
  if (tenantLocals.surface !== "tenant" && !tenantLocals.isLocalLoopback) {
    return createApiErrorJsonResponse(404, "NOT_FOUND", "Halaman tidak ditemukan.", requestId);
  }
  return createApiErrorJsonResponse(
    405,
    "BAD_REQUEST",
    "Metode HTTP tidak diizinkan untuk endpoint laporan penyalahgunaan.",
    requestId,
    undefined,
    { Allow: "POST" },
  );
};

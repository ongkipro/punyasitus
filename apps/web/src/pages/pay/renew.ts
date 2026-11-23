import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import {
  consumeRenewalPayLink,
  lookupRenewalPayLinkByToken,
} from "@punyasitus/db/billing/index";
import { createStatePageResponse } from "../../core/tenant.ts";
import { resolvePlatformAuthHostContext, type AuthRuntimeEnv } from "../../middleware/auth.ts";

/**
 * One-Click Renewal Pay Link Consumer Route (`GET /pay/renew?token=...`, DEC-035 C17, REQ-060).
 *
 * Security invariants:
 * - Served strictly on `app.punyasitus.com` (and explicit local loopback in `APP_ENV === "local"`);
 *   returns neutral `404` on tenant, console, and marketing hosts.
 * - Atomically consumes single-use, SHA-256 hashed, grace-expiring tokens bound to the target tenant.
 * - NEVER emits `Set-Cookie`, NEVER creates or leaks an admin session, NEVER activates service
 *   or grants entitlement, and NEVER leaks tenant existence on invalid/expired/replayed tokens.
 * - Sets `Cache-Control: private, no-store, no-cache, must-revalidate`, `X-Robots-Tag: noindex, nofollow`,
 *   and `Referrer-Policy: no-referrer` on every response.
 */

const NON_COMMERCIAL_TERMINAL_STATUSES = new Set([
  "provisioning",
  "purging",
  "purged",
  "recovery",
]);

const TOKEN_FORMAT_RE = /^[a-f0-9]{32,128}$/i;

const RENEW_SECURITY_HEADERS = {
  "Cache-Control": "private, no-store, no-cache, must-revalidate",
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "no-referrer",
} as const;

function wantsJson(request: Request): boolean {
  const accept = (request.headers.get("accept") ?? "").toLowerCase();
  return accept.includes("application/json") && !accept.includes("text/html");
}

function buildErrorResponse(
  request: Request,
  status: 400 | 410 | 503,
  code: string,
  title: string,
  message: string,
): Response {
  const headers = new Headers(RENEW_SECURITY_HEADERS);
  if (wantsJson(request)) {
    headers.set("Content-Type", "application/json; charset=utf-8");
    return new Response(
      JSON.stringify({
        success: false,
        code,
        message,
        error: { code, message },
      }),
      { status, headers },
    );
  }

  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'");
  const html = [
    "<!doctype html>",
    '<html lang="id">',
    "<head>",
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width,initial-scale=1" />',
    '<meta name="robots" content="noindex, nofollow" />',
    `<title>${title} — PunyaSitus</title>`,
    "<style>body{margin:0;min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:1.5rem 1rem;background:#f8fafc;color:#0f172a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif}main{max-width:30rem;width:100%;background:#fff;border:1px solid #e2e8f0;border-radius:.75rem;padding:2rem 1.5rem;text-align:center}h1{margin:0 0 .75rem;font-size:1.375rem}p{margin:0 0 1.25rem;color:#475569;line-height:1.6}a{display:inline-block;padding:.625rem 1.125rem;border-radius:.5rem;background:#176b51;color:#fff;text-decoration:none;font-weight:600;font-size:.875rem}</style>",
    "</head>",
    "<body>",
    `<main><h1>${title}</h1><p>${message}</p><a href="/auth/login">Masuk ke Dashboard</a></main>`,
    "</body>",
    "</html>",
  ].join("");

  return new Response(html, { status, headers });
}

export async function handleRenewalPayLinkRequest(
  request: Request,
  runtimeEnv: AuthRuntimeEnv,
  options: { readonly nowMs?: number } = {},
): Promise<Response> {
  const hostCtx = resolvePlatformAuthHostContext(request, runtimeEnv);
  if (!hostCtx.allowed || hostCtx.surface !== "app") {
    return createStatePageResponse("not_found", {
      pathname: "/pay/renew",
      surface: hostCtx.allowed ? hostCtx.surface : "unknown",
    });
  }

  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return buildErrorResponse(
      request,
      400,
      "INVALID_RENEWAL_TOKEN",
      "Tautan Pembayaran Tidak Valid",
      "Permintaan tautan pembayaran tidak valid. Silakan masuk ke akun Anda untuk melanjutkan pembayaran.",
    );
  }

  const rawToken = (url.searchParams.get("token") ?? "").trim();
  if (!rawToken || !TOKEN_FORMAT_RE.test(rawToken)) {
    return buildErrorResponse(
      request,
      400,
      "INVALID_RENEWAL_TOKEN",
      "Tautan Pembayaran Tidak Valid",
      "Token perpanjangan tidak ditemukan atau formatnya tidak valid. Silakan masuk ke dashboard untuk membuka halaman langganan.",
    );
  }

  if (!runtimeEnv.PLATFORM_DB) {
    return buildErrorResponse(
      request,
      503,
      "SERVICE_UNAVAILABLE",
      "Layanan Sedang Tidak Tersedia",
      "Sistem pembayaran sementara tidak dapat memverifikasi tautan Anda. Silakan coba beberapa saat lagi.",
    );
  }

  const nowMs = Math.trunc(options.nowMs ?? Date.now());
  const found = await lookupRenewalPayLinkByToken(runtimeEnv.PLATFORM_DB, rawToken);

  if (!found || NON_COMMERCIAL_TERMINAL_STATUSES.has(found.tenantStatus)) {
    return buildErrorResponse(
      request,
      410,
      "RENEWAL_LINK_EXPIRED_OR_INVALID",
      "Tautan Perpanjangan Tidak Berlaku",
      "Tautan bayar sekali klik ini sudah digunakan, kedaluwarsa, atau tidak lagi berlaku. Silakan masuk ke akun PunyaSitus Anda untuk melanjutkan perpanjangan langganan.",
    );
  }

  const consumed = await consumeRenewalPayLink(runtimeEnv.PLATFORM_DB, {
    rawToken,
    expectedTenantId: found.tenantId,
    nowMs,
  });

  if (!consumed.ok) {
    return buildErrorResponse(
      request,
      410,
      "RENEWAL_LINK_EXPIRED_OR_INVALID",
      "Tautan Perpanjangan Tidak Berlaku",
      "Tautan bayar sekali klik ini sudah digunakan atau telah melewati batas masa tenggang. Silakan masuk ke akun PunyaSitus Anda untuk melanjutkan perpanjangan langganan.",
    );
  }

  const targetParams = new URLSearchParams({ renew: "1" });
  if (consumed.link.obligationId) {
    targetParams.set("obligation", consumed.link.obligationId);
  }

  const location = `/dashboard/${encodeURIComponent(found.tenantHandle)}/billing?${targetParams.toString()}`;
  const headers = new Headers({
    ...RENEW_SECURITY_HEADERS,
    Location: location,
  });

  return new Response(null, {
    status: 302,
    headers,
  });
}

export const GET: APIRoute = async ({ request }) => {
  const runtimeEnv = env as unknown as AuthRuntimeEnv;
  return handleRenewalPayLinkRequest(request, runtimeEnv);
};

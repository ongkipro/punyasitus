import type { PluginTenantDb } from "@punyasitus/core/plugins/index";
import {
  DEFAULT_OUTBOUND_TIMEOUT_MS,
  DEFAULT_RETRY_BASE_DELAY_MS,
  DEFAULT_TOTAL_DEADLINE_MS,
  HARD_MAX_OUTBOUND_TIMEOUT_MS,
  HARD_MAX_TOTAL_DEADLINE_MS,
  LEAD_NOTIFIER_TABLES,
  MAX_WEBHOOK_REDIRECT_HOPS,
  TELEGRAM_API_BASE_URL,
  WEBHOOK_DEFAULT_MAX_RETRIES,
  WEBHOOK_DELIVERY_ID_HEADER,
  WEBHOOK_EVENT_HEADER,
  WEBHOOK_HARD_MAX_RETRIES,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
} from "./constants.ts";
import { buildWebhookSignatureHeader, generateDeliveryId } from "./crypto.ts";
import {
  buildWebhookLeadPayload,
  formatTelegramLeadMessage,
  type NormalizedLeadEvent,
} from "./formatter.ts";
import { validateWebhookTargetUrl } from "./ssrf.ts";
import { sanitizeWebhookTargetSummary } from "./tokens.ts";

/**
 * Fault-Isolated Outbound Notifiers (Telegram Bot API + Signed SSRF-Guarded HTTPS Webhooks)
 * with single global deadline budget, bounded body cancellation, same-origin redirect enforcement,
 * SSRF redirect-hop re-validation, capped retries, and scrubbed `plg_lead_notifier__deliveries`
 * persistence (`REQ-101`, `TASK-101`).
 */

export type DeliveryStatus = "delivered" | "failed" | "skipped" | "timed_out";

export interface DeliveryAttemptResult {
  readonly ok: boolean;
  readonly channel: "telegram" | "webhook";
  readonly deliveryId: string;
  readonly status: DeliveryStatus;
  readonly httpStatus: number | null;
  readonly attempts: number;
  readonly errorCode: string | null;
  readonly targetSummary: string;
  readonly whatsappFollowUpUrl?: string | null;
}

export interface DeliveryTransportOptions {
  readonly fetchFn?: typeof fetch;
  /** Per-attempt timeout ceiling in ms. */
  readonly timeoutMs?: number;
  /** Single overall wall-clock deadline budget across ALL attempts/hops in ms (capped <= 9500ms). */
  readonly totalDeadlineMs?: number;
  readonly retryBaseDelayMs?: number;
  readonly sleepFn?: (ms: number) => Promise<void>;
  readonly nowMs?: () => number;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function clampTimeoutMs(raw?: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_OUTBOUND_TIMEOUT_MS;
  }
  return Math.min(HARD_MAX_OUTBOUND_TIMEOUT_MS, Math.max(25, Math.trunc(raw)));
}

function clampTotalDeadlineMs(raw?: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_TOTAL_DEADLINE_MS;
  }
  return Math.min(HARD_MAX_TOTAL_DEADLINE_MS, Math.max(50, Math.trunc(raw)));
}

function clampRetries(raw?: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 1) {
    return WEBHOOK_DEFAULT_MAX_RETRIES;
  }
  return Math.min(WEBHOOK_HARD_MAX_RETRIES, Math.max(1, Math.trunc(raw)));
}

function sanitizeErrorCode(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const clean = raw
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
  return clean || "DELIVERY_ERROR";
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function defaultSleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithBoundedTimeout(
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<
  | { readonly ok: true; readonly response: Response }
  | { readonly ok: false; readonly timedOut: boolean; readonly errorCode: string }
> {
  if (timeoutMs <= 0) {
    return { ok: false, timedOut: true, errorCode: "REQUEST_TIMEOUT" };
  }

  const controller = new AbortController();
  let didTimeout = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      didTimeout = true;
      try {
        controller.abort();
      } catch {
        // Best-effort abort
      }
      reject(new Error("REQUEST_TIMEOUT"));
    }, timeoutMs);
  });

  try {
    const response = await Promise.race([
      fetchFn(url, {
        ...init,
        signal: controller.signal,
      }),
      timeoutPromise,
    ]);
    return { ok: true, response };
  } catch (err) {
    const isAbort =
      didTimeout ||
      (err instanceof Error &&
        (err.name === "AbortError" ||
          err.message === "REQUEST_TIMEOUT" ||
          err.message.toLowerCase().includes("timeout")));
    return {
      ok: false,
      timedOut: isAbort,
      errorCode: isAbort ? "REQUEST_TIMEOUT" : "NETWORK_ERROR",
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Cancels the unread response body stream inside a strict time budget so slow/tarpit
 * endpoints can never stall the Worker past the global deadline.
 */
async function cancelResponseBodyBounded(res: Response, maxWaitMs: number): Promise<void> {
  const body = res.body;
  if (!body || typeof body.cancel !== "function") return;
  const capMs = Math.min(250, Math.max(10, Math.trunc(maxWaitMs)));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      body.cancel().catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, capMs);
      }),
    ]);
  } catch {
    // Best-effort stream cancel
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Delivers a formatted Telegram lead alert with an optional tap-to-WhatsApp button.
 * Enforces a single global deadline budget across all attempts.
 * NEVER throws unhandled errors and NEVER exposes bot tokens or raw chat IDs in results.
 */
export async function deliverTelegramLeadAlert(input: {
  readonly botToken: string;
  readonly chatId: string;
  readonly maskedChatLabel: string;
  readonly lead: NormalizedLeadEvent;
  readonly deliveryId?: string;
  readonly apiBaseUrl?: string;
  readonly maxAttempts?: number;
  readonly transport?: DeliveryTransportOptions;
}): Promise<DeliveryAttemptResult> {
  const deliveryId = input.deliveryId ?? generateDeliveryId("tg");
  const targetSummary = input.maskedChatLabel || "Telegram";
  const { payload, whatsappFollowUp } = formatTelegramLeadMessage(input.chatId, input.lead);

  const botToken = input.botToken.trim();
  if (!botToken) {
    return {
      ok: false,
      channel: "telegram",
      deliveryId,
      status: "skipped",
      httpStatus: null,
      attempts: 0,
      errorCode: "TELEGRAM_BOT_TOKEN_MISSING",
      targetSummary,
      whatsappFollowUpUrl: whatsappFollowUp?.url ?? null,
    };
  }

  const fetchFn = input.transport?.fetchFn ?? globalThis.fetch;
  const perAttemptTimeoutMs = clampTimeoutMs(input.transport?.timeoutMs);
  const totalDeadlineMs = clampTotalDeadlineMs(input.transport?.totalDeadlineMs);
  const deadlineAt = Date.now() + totalDeadlineMs;
  const retryBaseDelayMs = Math.min(
    1_000,
    Math.max(0, input.transport?.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS),
  );
  const sleepFn = input.transport?.sleepFn ?? defaultSleep;
  const maxAttempts = Math.min(2, Math.max(1, Math.trunc(input.maxAttempts ?? 2)));
  const apiBase = (input.apiBaseUrl ?? TELEGRAM_API_BASE_URL).replace(/\/+$/, "");
  const endpoint = `${apiBase}/bot${botToken}/sendMessage`;
  const body = JSON.stringify(payload);

  let lastHttpStatus: number | null = null;
  let lastErrorCode = "TELEGRAM_DELIVERY_FAILED";
  let timedOut = false;
  let attemptsRun = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) {
      timedOut = true;
      lastErrorCode = "REQUEST_TIMEOUT";
      break;
    }

    attemptsRun = attempt;
    const effectiveTimeoutMs = Math.min(perAttemptTimeoutMs, remainingMs);
    const fetched = await fetchWithBoundedTimeout(
      fetchFn,
      endpoint,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "User-Agent": "PunyaSitus-LeadNotifier/1.0",
        },
        body,
        redirect: "error",
      },
      effectiveTimeoutMs,
    );

    if (!fetched.ok) {
      timedOut = fetched.timedOut;
      lastErrorCode = fetched.errorCode;
      const afterMs = deadlineAt - Date.now();
      if (attempt < maxAttempts && afterMs > 25) {
        const delayMs = Math.min(1_500, retryBaseDelayMs * 2 ** (attempt - 1), Math.max(0, afterMs - 25));
        await sleepFn(delayMs);
        continue;
      }
      break;
    }

    const res = fetched.response;
    lastHttpStatus = res.status;
    await cancelResponseBodyBounded(res, Math.max(10, deadlineAt - Date.now()));

    if (res.ok) {
      return {
        ok: true,
        channel: "telegram",
        deliveryId,
        status: "delivered",
        httpStatus: res.status,
        attempts: attempt,
        errorCode: null,
        targetSummary,
        whatsappFollowUpUrl: whatsappFollowUp?.url ?? null,
      };
    }

    lastErrorCode = `HTTP_${res.status}`;
    const afterMs = deadlineAt - Date.now();
    if (!isRetryableStatus(res.status) || attempt >= maxAttempts || afterMs <= 25) {
      return {
        ok: false,
        channel: "telegram",
        deliveryId,
        status: "failed",
        httpStatus: res.status,
        attempts: attempt,
        errorCode: lastErrorCode,
        targetSummary,
        whatsappFollowUpUrl: whatsappFollowUp?.url ?? null,
      };
    }

    const delayMs = Math.min(1_500, retryBaseDelayMs * 2 ** (attempt - 1), Math.max(0, afterMs - 25));
    await sleepFn(delayMs);
  }

  return {
    ok: false,
    channel: "telegram",
    deliveryId,
    status: timedOut ? "timed_out" : "failed",
    httpStatus: lastHttpStatus,
    attempts: Math.max(1, attemptsRun),
    errorCode: lastErrorCode,
    targetSummary,
    whatsappFollowUpUrl: whatsappFollowUp?.url ?? null,
  };
}

/**
 * Delivers an HMAC-SHA256 signed HTTPS webhook with:
 * - Strict SSRF validation on the initial URL and EVERY redirect hop (`redirect: "manual"`)
 * - Strict refusal of cross-origin redirects so `X-PunyaSitus-Signature` + payload never leak cross-origin
 * - Single overall wall-clock deadline budget across all attempts & redirect hops
 * - Bounded stream cancellation (never unbounded body drain)
 * - Bounded retries on transient failures (network, timeout, 408, 429, 5xx)
 * NEVER throws unhandled errors.
 */
export async function deliverSignedHttpsWebhook(input: {
  readonly targetUrl: string;
  readonly signingSecret: string;
  readonly lead: NormalizedLeadEvent;
  readonly eventName?: "lead.created" | "lead.test";
  readonly deliveryId?: string;
  readonly maxRetries?: number;
  readonly transport?: DeliveryTransportOptions;
}): Promise<DeliveryAttemptResult> {
  const deliveryId = input.deliveryId ?? generateDeliveryId("wh");
  const eventName = input.eventName ?? "lead.created";
  const targetSummary = sanitizeWebhookTargetSummary(input.targetUrl);

  const initialValidation = validateWebhookTargetUrl(input.targetUrl);
  if (!initialValidation.ok) {
    return {
      ok: false,
      channel: "webhook",
      deliveryId,
      status: "failed",
      httpStatus: null,
      attempts: 0,
      errorCode: initialValidation.code,
      targetSummary,
    };
  }

  const initialOrigin = new URL(initialValidation.normalizedUrl).origin;
  const fetchFn = input.transport?.fetchFn ?? globalThis.fetch;
  const perAttemptTimeoutMs = clampTimeoutMs(input.transport?.timeoutMs);
  const totalDeadlineMs = clampTotalDeadlineMs(input.transport?.totalDeadlineMs);
  const deadlineAt = Date.now() + totalDeadlineMs;
  const retryBaseDelayMs = Math.min(
    1_000,
    Math.max(0, input.transport?.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS),
  );
  const sleepFn = input.transport?.sleepFn ?? defaultSleep;
  const nowFn = input.transport?.nowMs ?? (() => Date.now());
  const maxAttempts = clampRetries(input.maxRetries);

  const payload = buildWebhookLeadPayload(input.lead, deliveryId, eventName);
  const rawBody = JSON.stringify(payload);

  let lastHttpStatus: number | null = null;
  let lastErrorCode = "WEBHOOK_DELIVERY_FAILED";
  let timedOut = false;
  let attemptsRun = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const attemptRemainingMs = deadlineAt - Date.now();
    if (attemptRemainingMs <= 0) {
      timedOut = true;
      lastErrorCode = "REQUEST_TIMEOUT";
      break;
    }

    attemptsRun = attempt;
    let currentUrl = initialValidation.normalizedUrl;
    let shouldRetry = false;

    for (let hop = 0; hop <= MAX_WEBHOOK_REDIRECT_HOPS; hop += 1) {
      const hopRemainingMs = deadlineAt - Date.now();
      if (hopRemainingMs <= 0) {
        timedOut = true;
        lastErrorCode = "REQUEST_TIMEOUT";
        shouldRetry = false;
        break;
      }

      const timestampSec = Math.floor(nowFn() / 1000);
      const signature = await buildWebhookSignatureHeader(
        input.signingSecret,
        rawBody,
        timestampSec,
      );

      const effectiveTimeoutMs = Math.min(perAttemptTimeoutMs, hopRemainingMs);
      const fetched = await fetchWithBoundedTimeout(
        fetchFn,
        currentUrl,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "User-Agent": "PunyaSitus-LeadNotifier/1.0",
            [WEBHOOK_SIGNATURE_HEADER]: signature,
            [WEBHOOK_EVENT_HEADER]: eventName,
            [WEBHOOK_DELIVERY_ID_HEADER]: deliveryId,
            [WEBHOOK_TIMESTAMP_HEADER]: String(timestampSec),
          },
          body: rawBody,
          redirect: "manual",
        },
        effectiveTimeoutMs,
      );

      if (!fetched.ok) {
        timedOut = fetched.timedOut;
        lastErrorCode = fetched.errorCode;
        shouldRetry = attempt < maxAttempts && deadlineAt - Date.now() > 25;
        break;
      }

      const res = fetched.response;
      lastHttpStatus = res.status;

      // Manually inspect redirect hops: re-apply SSRF guard AND refuse cross-origin redirects!
      if (REDIRECT_STATUSES.has(res.status)) {
        const locationHeader = res.headers.get("location")?.trim() ?? "";
        await cancelResponseBodyBounded(res, Math.max(10, deadlineAt - Date.now()));

        if (!locationHeader) {
          return {
            ok: false,
            channel: "webhook",
            deliveryId,
            status: "failed",
            httpStatus: res.status,
            attempts: attempt,
            errorCode: "SSRF_REDIRECT_BLOCKED",
            targetSummary,
          };
        }

        let resolvedRedirectUrl: string;
        try {
          resolvedRedirectUrl = new URL(locationHeader, currentUrl).toString();
        } catch {
          return {
            ok: false,
            channel: "webhook",
            deliveryId,
            status: "failed",
            httpStatus: res.status,
            attempts: attempt,
            errorCode: "SSRF_REDIRECT_BLOCKED",
            targetSummary,
          };
        }

        const hopCheck = validateWebhookTargetUrl(resolvedRedirectUrl);
        if (!hopCheck.ok) {
          return {
            ok: false,
            channel: "webhook",
            deliveryId,
            status: "failed",
            httpStatus: res.status,
            attempts: attempt,
            errorCode: "SSRF_REDIRECT_BLOCKED",
            targetSummary,
          };
        }

        // Refuse cross-origin redirects so HMAC signature + signed payload NEVER leak to a third-party origin
        if (new URL(hopCheck.normalizedUrl).origin !== initialOrigin) {
          return {
            ok: false,
            channel: "webhook",
            deliveryId,
            status: "failed",
            httpStatus: res.status,
            attempts: attempt,
            errorCode: "CROSS_ORIGIN_REDIRECT_BLOCKED",
            targetSummary,
          };
        }

        if (hop >= MAX_WEBHOOK_REDIRECT_HOPS) {
          return {
            ok: false,
            channel: "webhook",
            deliveryId,
            status: "failed",
            httpStatus: res.status,
            attempts: attempt,
            errorCode: "TOO_MANY_REDIRECTS",
            targetSummary,
          };
        }

        currentUrl = hopCheck.normalizedUrl;
        continue;
      }

      await cancelResponseBodyBounded(res, Math.max(10, deadlineAt - Date.now()));

      if (res.ok) {
        return {
          ok: true,
          channel: "webhook",
          deliveryId,
          status: "delivered",
          httpStatus: res.status,
          attempts: attempt,
          errorCode: null,
          targetSummary,
        };
      }

      lastErrorCode = `HTTP_${res.status}`;
      if (!isRetryableStatus(res.status)) {
        return {
          ok: false,
          channel: "webhook",
          deliveryId,
          status: "failed",
          httpStatus: res.status,
          attempts: attempt,
          errorCode: lastErrorCode,
          targetSummary,
        };
      }

      shouldRetry = attempt < maxAttempts && deadlineAt - Date.now() > 25;
      break;
    }

    const remainingBeforeSleep = deadlineAt - Date.now();
    if (shouldRetry && remainingBeforeSleep > 25) {
      const delayMs = Math.min(
        2_000,
        retryBaseDelayMs * 2 ** (attempt - 1),
        Math.max(0, remainingBeforeSleep - 25),
      );
      await sleepFn(delayMs);
      continue;
    }

    return {
      ok: false,
      channel: "webhook",
      deliveryId,
      status: timedOut ? "timed_out" : "failed",
      httpStatus: lastHttpStatus,
      attempts: attempt,
      errorCode: lastErrorCode,
      targetSummary,
    };
  }

  return {
    ok: false,
    channel: "webhook",
    deliveryId,
    status: timedOut ? "timed_out" : "failed",
    httpStatus: lastHttpStatus,
    attempts: Math.max(1, attemptsRun),
    errorCode: lastErrorCode,
    targetSummary,
  };
}

/**
 * Best-effort delivery log writer into `plg_lead_notifier__deliveries`.
 * Strictly scrubs error codes and target summaries; NEVER throws.
 */
export async function recordDeliveryLogBestEffort(
  db: PluginTenantDb,
  record: {
    readonly deliveryId: string;
    readonly tenantId: string;
    readonly eventId: string;
    readonly eventName: string;
    readonly leadId: number | null;
    readonly channel: "telegram" | "webhook";
    readonly status: DeliveryStatus;
    readonly httpStatus: number | null;
    readonly attempts: number;
    readonly errorCode: string | null;
    readonly targetSummary: string | null;
    readonly createdAt: number;
    readonly completedAt: number;
  },
): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT OR IGNORE INTO ${LEAD_NOTIFIER_TABLES.deliveries} (
           delivery_id, tenant_id, event_id, event_name, lead_id,
           channel, status, http_status, attempts, error_code,
           target_summary, created_at, completed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        record.deliveryId,
        record.tenantId,
        record.eventId,
        record.eventName,
        record.leadId,
        record.channel,
        record.status,
        record.httpStatus,
        Math.max(0, Math.trunc(record.attempts)),
        sanitizeErrorCode(record.errorCode),
        record.targetSummary ? record.targetSummary.slice(0, 120) : null,
        Math.trunc(record.createdAt),
        Math.trunc(record.completedAt),
      )
      .run();
  } catch {
    // Non-blocking audit log write: NEVER propagate failures into lead creation or hooks
  }
}

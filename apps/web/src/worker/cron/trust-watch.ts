import { normalizeHost, PLATFORM_HOSTS } from "@punyasitus/core";
import {
  resolveEmailPort,
  type CloudflareSendEmailBinding,
  type EmailPort,
} from "@punyasitus/core/email/index";
import { redactJobLogRecord } from "@punyasitus/core/jobs/index";
import type { ModerationQueueSenderLike } from "@punyasitus/db/abuse/index";
import {
  claimDailyTrustWatchAlert,
  listActiveTenantHostsForTrustWatch,
  listOperatorAlertEmails,
  MAX_TRUST_WATCH_TENANT_HOSTS,
  recordTrustWatchRun,
  releaseDailyTrustWatchAlert,
  type TrustWatchHostFailure,
  type TrustWatchHostHit,
  type TrustWatchRunRecord,
  type TrustWatchRunStatus,
} from "@punyasitus/db/content-screening/index";
import { generatePlatformAuditId } from "@punyasitus/db/platform";
import type { PunyasitusEnv } from "../env.d.ts";
import type { DurableJobHandler, DurableJobRegistry } from "../queues/consumer.ts";
import { DEFAULT_CRON_EXPRESSION, type ScheduledCronJobDefinition } from "./scheduler.ts";

/**
 * Daily Trust+ Komdigi IP Watch Cron (`REQ-103`, `PLAN.md` §20.1, `DEC-043`, `TASK-103`).
 *
 * Invariants:
 * - Resolves platform hosts, `cname.<saasZone>`, standby fallback zone, and every active
 *   tenant host over DNS-over-HTTPS (IPv4 A records) in bounded parallel batches (`10` at a time)
 *   and compares against Komdigi's published Trust+ IP list.
 * - Absence of data is NEVER evidence of cleanliness: if the list cannot be fetched/parsed,
 *   the active tenant host query exceeds `MAX_TRUST_WATCH_TENANT_HOSTS` (`hostsCapped: true`),
 *   or any target host fails DNS resolution without a hit, status is strictly `"unknown"`, NEVER `"clean"`.
 * - Every hit is logged and persisted in `PLATFORM_DB.trust_watch_runs`, while operator alerts
 *   are atomically capped to AT MOST ONCE PER WIB DAY via `PLATFORM_DB.trust_watch_alert_days`.
 * - If alert delivery fails or no delivery transport succeeds, the daily claim slot is released
 *   immediately so the next run retries instead of silently dropping the alert all day.
 * - Uses injectable `DnsProbePort` & `TrustPositifListPort` so unit/integration tests perform
 *   ZERO live external network calls.
 */

export const TRUST_POSITIF_IP_LIST_URL =
  "https://trustpositif.komdigi.go.id/assets/db/ipaddress_isp" as const;

export const CLOUDFLARE_DOH_JSON_URL = "https://cloudflare-dns.com/dns-query" as const;

export const TRUST_WATCH_TOPIC = "cron.daily_trust_watch" as const;
export const DEFAULT_FALLBACK_SAAS_ZONE = "situsku.my.id" as const;
export const DEFAULT_PRIMARY_SAAS_ZONE = "situsku.click" as const;
export const DNS_PROBE_CONCURRENCY = 10 as const;

const EMAIL_DELIVERY_TOPIC = "email.transactional.send" as const;

export const TRUST_WATCH_CRON_JOB_DEFINITION: ScheduledCronJobDefinition = {
  name: "daily-trust-positif-watch",
  cron: DEFAULT_CRON_EXPRESSION,
  topic: TRUST_WATCH_TOPIC,
  cadence: "daily",
  tenantId: null,
  maxAttempts: 2,
};

export interface TrustPositifListFetchSuccess {
  readonly ok: true;
  readonly ips: ReadonlySet<string>;
}

export interface TrustPositifListFetchFailure {
  readonly ok: false;
  readonly errorCode: string;
  readonly message: string;
}

export type TrustPositifListFetchResult =
  | TrustPositifListFetchSuccess
  | TrustPositifListFetchFailure;

export interface TrustPositifListPort {
  fetchIpList(sourceUrl: string): Promise<TrustPositifListFetchResult>;
}

export interface DnsProbeSuccess {
  readonly ok: true;
  readonly ips: readonly string[];
}

export interface DnsProbeFailure {
  readonly ok: false;
  readonly errorCode: string;
  readonly message: string;
}

export type DnsProbeResult = DnsProbeSuccess | DnsProbeFailure;

export interface DnsProbePort {
  resolveIpv4(hostname: string): Promise<DnsProbeResult>;
}

export interface TrustWatchTargetHost {
  readonly host: string;
  readonly source: "platform" | "saas_zone" | "fallback_zone" | "tenant_host";
  readonly tenantId: string | null;
}

export interface TrustWatchAlertPayload {
  readonly runId: string;
  readonly runDay: string;
  readonly messageKey: string;
  readonly hits: readonly TrustWatchHostHit[];
  readonly recipients: readonly string[];
}

export interface TrustWatchEnv {
  readonly PLATFORM_DB: D1Database;
  readonly PLATFORM_DOMAIN?: string;
  readonly SAAS_ZONE?: string;
  readonly FALLBACK_SAAS_ZONE?: string;
  readonly TRUST_POSITIF_IP_LIST_URL?: string;
  readonly OPS_ALERT_EMAIL?: string;
  readonly EMAIL?: CloudflareSendEmailBinding | null;
  readonly RESEND_API_KEY?: string | null;
  readonly JOBS_QUEUE?: ModerationQueueSenderLike | null;
}

export interface RunDailyTrustWatchOptions {
  readonly dnsPort?: DnsProbePort;
  readonly listPort?: TrustPositifListPort;
  readonly emailPort?: EmailPort | null;
  readonly jobsQueue?: ModerationQueueSenderLike | null;
  readonly onAlert?: (alert: TrustWatchAlertPayload) => Promise<void> | void;
  readonly alertRecipients?: readonly string[];
  readonly extraHosts?: readonly TrustWatchTargetHost[];
  readonly listSourceUrl?: string;
  readonly maxTenantHosts?: number;
  readonly dnsConcurrency?: number;
  readonly nowMs?: number;
  readonly logger?: (entry: Record<string, unknown>) => void;
}

export interface TrustWatchExecutionResult {
  readonly run: TrustWatchRunRecord;
  readonly status: TrustWatchRunStatus;
  readonly hostsCapped: boolean;
  readonly alertSent: boolean;
  readonly alertDeduplicated: boolean;
  readonly hits: readonly TrustWatchHostHit[];
  readonly failures: readonly TrustWatchHostFailure[];
}

const MAX_LIST_LINES = 500_000;
const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;

/**
 * Strictly validates a dotted-quad IPv4 address (`0.0.0.0` .. `255.255.255.255`) in linear time.
 */
export function isValidIpv4(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 4) return false;
  for (const part of parts) {
    if (!part || part.length > 3) return false;
    if (part.length > 1 && part.startsWith("0")) return false;
    let num = 0;
    for (let i = 0; i < part.length; i += 1) {
      const code = part.charCodeAt(i);
      if (code < 0x30 || code > 0x39) return false;
      num = num * 10 + (code - 0x30);
    }
    if (num < 0 || num > 255) return false;
  }
  return true;
}

/**
 * Parses Komdigi Trust+ IP list plain text (one IPv4 per line, ignoring blanks and `#` comments).
 */
export function parseTrustPositifIpList(rawText: string): ReadonlySet<string> {
  const ips = new Set<string>();
  const lines = rawText.split(/\r?\n/);
  const cap = Math.min(lines.length, MAX_LIST_LINES);
  for (let i = 0; i < cap; i += 1) {
    const rawLine = lines[i]?.trim() ?? "";
    if (!rawLine || rawLine.startsWith("#") || rawLine.startsWith(";")) continue;
    const token = rawLine.split(/\s+/)[0] ?? "";
    if (isValidIpv4(token)) {
      ips.add(token);
    }
  }
  return ips;
}

/**
 * Formats an epoch timestamp into an operational WIB (`Asia/Jakarta`, UTC+7) calendar date `YYYY-MM-DD`.
 */
export function formatWibDateDay(timestampMs: number): string {
  const wib = new Date(timestampMs + WIB_OFFSET_MS);
  const y = wib.getUTCFullYear();
  const m = String(wib.getUTCMonth() + 1).padStart(2, "0");
  const d = String(wib.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function createHttpTrustPositifListPort(
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = 8_000,
): TrustPositifListPort {
  return {
    async fetchIpList(sourceUrl: string): Promise<TrustPositifListFetchResult> {
      try {
        const res = await fetchImpl(sourceUrl, {
          method: "GET",
          headers: {
            Accept: "text/plain, */*;q=0.5",
            "User-Agent": "punyasitus-trust-watch/1.0",
          },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) {
          return {
            ok: false,
            errorCode: `TRUST_LIST_HTTP_${res.status}`,
            message: `Trust+ IP list returned HTTP ${res.status}`,
          };
        }
        const text = await res.text();
        const ips = parseTrustPositifIpList(text);
        if (ips.size === 0) {
          return {
            ok: false,
            errorCode: "TRUST_LIST_EMPTY",
            message: "Trust+ IP list response contained zero valid IPv4 addresses.",
          };
        }
        return { ok: true, ips };
      } catch (err) {
        return {
          ok: false,
          errorCode: "TRUST_LIST_FETCH_ERROR",
          message: err instanceof Error ? err.message : "Failed to fetch Trust+ IP list",
        };
      }
    },
  };
}

interface DohJsonAnswer {
  readonly type?: number;
  readonly data?: string;
}

interface DohJsonResponse {
  readonly Status?: number;
  readonly Answer?: readonly DohJsonAnswer[];
}

export function createCloudflareDohDnsProbePort(
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = 5_000,
): DnsProbePort {
  return {
    async resolveIpv4(hostname: string): Promise<DnsProbeResult> {
      const clean = normalizeHost(hostname);
      if (!clean) {
        return { ok: false, errorCode: "INVALID_HOSTNAME", message: "Invalid hostname" };
      }
      try {
        const url = `${CLOUDFLARE_DOH_JSON_URL}?name=${encodeURIComponent(clean)}&type=A`;
        const res = await fetchImpl(url, {
          method: "GET",
          headers: {
            Accept: "application/dns-json",
            "User-Agent": "punyasitus-trust-watch/1.0",
          },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) {
          return {
            ok: false,
            errorCode: `DOH_HTTP_${res.status}`,
            message: `DoH returned HTTP ${res.status}`,
          };
        }
        const body = (await res.json()) as DohJsonResponse;
        if (typeof body.Status === "number" && body.Status !== 0) {
          return {
            ok: false,
            errorCode: `DOH_RCODE_${body.Status}`,
            message: `DNS resolution failed with rcode ${body.Status}`,
          };
        }
        const ips: string[] = [];
        for (const ans of body.Answer ?? []) {
          if (ans.type === 1 && typeof ans.data === "string" && isValidIpv4(ans.data.trim())) {
            ips.push(ans.data.trim());
          }
        }
        if (ips.length === 0) {
          return {
            ok: false,
            errorCode: "DOH_NO_A_RECORDS",
            message: "No IPv4 A records returned by DoH",
          };
        }
        return { ok: true, ips };
      } catch (err) {
        return {
          ok: false,
          errorCode: "DOH_FETCH_ERROR",
          message: err instanceof Error ? err.message : "DoH query failed",
        };
      }
    },
  };
}

function buildTargetHostList(
  env: TrustWatchEnv,
  activeTenantHosts: readonly { readonly host: string; readonly tenantId: string }[],
  extraHosts: readonly TrustWatchTargetHost[] = [],
): readonly TrustWatchTargetHost[] {
  const byHost = new Map<string, TrustWatchTargetHost>();
  const add = (item: TrustWatchTargetHost) => {
    const clean = normalizeHost(item.host);
    if (!clean) return;
    if (!byHost.has(clean)) {
      byHost.set(clean, { ...item, host: clean });
    }
  };

  const platformDomain = normalizeHost(env.PLATFORM_DOMAIN) ?? PLATFORM_HOSTS.marketing;
  add({ host: platformDomain, source: "platform", tenantId: null });
  add({ host: `app.${platformDomain}`, source: "platform", tenantId: null });
  add({ host: `console.${platformDomain}`, source: "platform", tenantId: null });

  const saasZone = normalizeHost(env.SAAS_ZONE) ?? DEFAULT_PRIMARY_SAAS_ZONE;
  add({ host: saasZone, source: "saas_zone", tenantId: null });
  add({ host: `cname.${saasZone}`, source: "saas_zone", tenantId: null });
  add({ host: `fallback.${saasZone}`, source: "saas_zone", tenantId: null });

  const fallbackZone = normalizeHost(env.FALLBACK_SAAS_ZONE) ?? DEFAULT_FALLBACK_SAAS_ZONE;
  if (fallbackZone !== saasZone) {
    add({ host: fallbackZone, source: "fallback_zone", tenantId: null });
    add({ host: `cname.${fallbackZone}`, source: "fallback_zone", tenantId: null });
  }

  for (const row of activeTenantHosts) {
    add({ host: row.host, source: "tenant_host", tenantId: row.tenantId });
  }

  for (const extra of extraHosts) {
    add(extra);
  }

  return Array.from(byHost.values());
}

function defaultLogger(entry: Record<string, unknown>): void {
  console.log(JSON.stringify(entry));
}

function buildTrustWatchHitAlertText(runDay: string, hits: readonly TrustWatchHostHit[]): string {
  const lines = [
    `PERINGATAN TRUST+ KOMDIGI (${runDay} WIB)`,
    "",
    `Ditemukan ${hits.length} kecocokan IPv4 pada daftar Trust+ Komdigi:`,
    ...hits.map(
      (h) => `- ${h.host} -> ${h.ip} (sumber: ${h.source}${h.tenantId ? `, tenant: ${h.tenantId}` : ""})`,
    ),
    "",
    "Tindakan segera: buka console.punyasitus.com/abuse dan ikuti prosedur docs/operations/trust-positif.md.",
  ];
  return lines.join("\n");
}

function resolveAlertRecipients(
  env: TrustWatchEnv,
  dbOperatorEmails: readonly string[],
  explicitRecipients?: readonly string[],
): readonly string[] {
  const out = new Set<string>();
  const addEmail = (raw?: string | null) => {
    if (!raw) return;
    for (const part of raw.split(",")) {
      const clean = part.trim().toLowerCase();
      if (clean && clean.includes("@")) out.add(clean);
    }
  };
  if (explicitRecipients && explicitRecipients.length > 0) {
    for (const r of explicitRecipients) addEmail(r);
  } else {
    addEmail(env.OPS_ALERT_EMAIL);
    for (const r of dbOperatorEmails) addEmail(r);
  }
  return Array.from(out);
}

/**
 * Executes one complete Trust+ Komdigi watch pass and persists its outcome in `PLATFORM_DB`.
 */
export async function runDailyTrustWatch(
  env: TrustWatchEnv,
  options: RunDailyTrustWatchOptions = {},
): Promise<TrustWatchExecutionResult> {
  const nowMs = Math.floor(options.nowMs ?? Date.now());
  const runDay = formatWibDateDay(nowMs);
  const runId = generatePlatformAuditId(nowMs);
  const listSourceUrl =
    options.listSourceUrl ?? env.TRUST_POSITIF_IP_LIST_URL ?? TRUST_POSITIF_IP_LIST_URL;
  const listPort = options.listPort ?? createHttpTrustPositifListPort();
  const dnsPort = options.dnsPort ?? createCloudflareDohDnsProbePort();
  const logger = options.logger ?? defaultLogger;
  const concurrency = Math.max(1, Math.min(25, Math.trunc(options.dnsConcurrency ?? DNS_PROBE_CONCURRENCY)));

  const { hosts: activeTenantHosts, hostsCapped } = await listActiveTenantHostsForTrustWatch(
    env.PLATFORM_DB,
    options.maxTenantHosts ?? MAX_TRUST_WATCH_TENANT_HOSTS,
  );
  const targets = buildTargetHostList(env, activeTenantHosts, options.extraHosts);

  // Step 1: Fetch Trust+ IP list — failure MUST yield `unknown`, NEVER `clean`!
  const listRes = await listPort.fetchIpList(listSourceUrl);
  if (!listRes.ok || listRes.ips.size === 0) {
    const errorCode = listRes.ok ? "TRUST_LIST_EMPTY" : listRes.errorCode;
    const run = await recordTrustWatchRun(env.PLATFORM_DB, {
      id: runId,
      runDay,
      status: "unknown",
      listSourceUrl,
      listEntryCount: null,
      checkedHostsCount: targets.length,
      resolvedHostsCount: 0,
      failedHostsCount: 0,
      hits: [],
      failures: [{ host: listSourceUrl, reason: errorCode }],
      alertSent: false,
      alertDeduplicated: false,
      alertMessageKey: null,
      errorCode,
      createdAtMs: nowMs,
    });

    logger(
      redactJobLogRecord({
        event: "trust_watch.completed",
        runId: run.id,
        runDay,
        status: "unknown",
        hostsCapped,
        errorCode,
        checkedHostsCount: targets.length,
        timestamp: nowMs,
      }),
    );

    return {
      run,
      status: "unknown",
      hostsCapped,
      alertSent: false,
      alertDeduplicated: false,
      hits: [],
      failures: run.failures,
    };
  }

  // Step 2: Resolve IPv4 A records in bounded parallel batches (`concurrency` at a time)
  const hits: TrustWatchHostHit[] = [];
  const failures: TrustWatchHostFailure[] = [];
  let resolvedHostsCount = 0;

  for (let i = 0; i < targets.length; i += concurrency) {
    const batch = targets.slice(i, i + concurrency);
    const settled = await Promise.all(
      batch.map(async (target) => ({
        target,
        dnsRes: await dnsPort.resolveIpv4(target.host),
      })),
    );

    for (const { target, dnsRes } of settled) {
      if (!dnsRes.ok || dnsRes.ips.length === 0) {
        failures.push({
          host: target.host,
          reason: dnsRes.ok ? "DOH_NO_A_RECORDS" : dnsRes.errorCode,
        });
        continue;
      }

      resolvedHostsCount += 1;
      for (const ip of dnsRes.ips) {
        if (listRes.ips.has(ip)) {
          hits.push({
            host: target.host,
            ip,
            source: target.source,
            tenantId: target.tenantId,
          });
        }
      }
    }
  }

  if (hostsCapped) {
    failures.push({
      host: "tenant_hosts:cap",
      reason: "TENANT_HOSTS_CAP_EXCEEDED",
    });
  }

  // Step 3: Fail-closed classification: hit > unknown (DNS failure OR host cap exceeded) > clean
  let status: TrustWatchRunStatus;
  let errorCode: string | null = null;
  if (hits.length > 0) {
    status = "hit";
  } else if (hostsCapped) {
    status = "unknown";
    errorCode = "TENANT_HOSTS_CAP_EXCEEDED";
  } else if (failures.length > 0 || resolvedHostsCount === 0) {
    status = "unknown";
    errorCode = failures.length > 0 ? "DNS_RESOLUTION_INCOMPLETE" : "NO_TARGETS_RESOLVED";
  } else {
    status = "clean";
  }

  // Persist run record first (so FK trust_watch_alert_days.first_run_id always resolves & every hit is logged!)
  const initialRun = await recordTrustWatchRun(env.PLATFORM_DB, {
    id: runId,
    runDay,
    status,
    listSourceUrl,
    listEntryCount: listRes.ips.size,
    checkedHostsCount: targets.length,
    resolvedHostsCount,
    failedHostsCount: failures.length,
    hits,
    failures,
    alertSent: false,
    alertDeduplicated: false,
    alertMessageKey: null,
    errorCode,
    createdAtMs: nowMs,
  });

  let alertSent = false;
  let alertDeduplicated = false;
  let alertMessageKey: string | null = null;

  // Step 4: On a hit, atomically claim the single daily notification slot (at most once per WIB day!)
  // If delivery fails or no delivery transport succeeds, RELEASE the claim slot so the next run retries!
  if (status === "hit") {
    const candidateKey = `trust-watch-hit:${runDay}`;
    const claim = await claimDailyTrustWatchAlert(env.PLATFORM_DB, {
      runDay,
      runId: initialRun.id,
      messageKey: candidateKey,
      hits,
      nowMs,
    });

    if (claim.claimed) {
      const dbOperatorEmails =
        options.alertRecipients && options.alertRecipients.length > 0
          ? []
          : await listOperatorAlertEmails(env.PLATFORM_DB);
      const recipients = resolveAlertRecipients(env, dbOperatorEmails, options.alertRecipients);

      const alertPayload: TrustWatchAlertPayload = {
        runId: initialRun.id,
        runDay,
        messageKey: candidateKey,
        hits,
        recipients,
      };

      const resolvedEmailPort =
        options.emailPort !== undefined
          ? options.emailPort
          : resolveEmailPort({
              cloudflareBinding: env.EMAIL ?? null,
              resendApiKey: env.RESEND_API_KEY ?? null,
            });
      const resolvedJobsQueue =
        options.jobsQueue !== undefined ? options.jobsQueue : (env.JOBS_QUEUE ?? null);

      if (options.onAlert) {
        try {
          await options.onAlert(alertPayload);
          alertSent = true;
        } catch {
          // Will release claim slot below if no other channel succeeds
        }
      }

      if (recipients.length > 0 && (resolvedEmailPort || resolvedJobsQueue)) {
        const subject = `[PunyaSitus][PENTING] Deteksi IP Trust+ Komdigi (${runDay})`;
        const textBody = buildTrustWatchHitAlertText(runDay, hits);
        const htmlBody = `<p><strong>Peringatan Trust+ Komdigi (${runDay} WIB)</strong></p><p>Ditemukan ${hits.length} kecocokan IPv4 pada daftar Trust+ Komdigi.</p><ul>${hits
          .map((h) => `<li><code>${h.host}</code> &rarr; <code>${h.ip}</code> (${h.source})</li>`)
          .join("")}</ul><p>Buka <code>console.punyasitus.com/abuse</code> dan ikuti <code>docs/operations/trust-positif.md</code>.</p>`;

        for (let i = 0; i < recipients.length; i += 1) {
          const to = recipients[i]!;
          const msgKey = `${candidateKey}:${i}`;
          if (resolvedEmailPort) {
            try {
              const sendRes = await resolvedEmailPort.send({
                messageKey: msgKey,
                template: "domain-notice",
                to,
                subject,
                html: htmlBody,
                text: textBody,
                tenantId: null,
              });
              if (sendRes.outcome === "submitted") {
                alertSent = true;
                continue;
              }
            } catch {
              // Fall through to durable queue outbox if available
            }
          }

          if (resolvedJobsQueue) {
            try {
              const jobPayload = {
                messageKey: msgKey,
                template: "domain-notice",
                to,
                subject,
                html: htmlBody,
                text: textBody,
                tenantId: null,
              };
              await env.PLATFORM_DB.prepare(
                `INSERT OR IGNORE INTO job_ledger (
                   idempotency_key, topic, tenant_id, status, attempts, payload_json, created_at, updated_at
                 ) VALUES (?, ?, NULL, 'queued', 0, ?, ?, ?)`,
              )
                .bind(msgKey, EMAIL_DELIVERY_TOPIC, JSON.stringify(jobPayload), nowMs, nowMs)
                .run();
              await resolvedJobsQueue.send({
                idempotencyKey: msgKey,
                topic: EMAIL_DELIVERY_TOPIC,
                tenantId: null,
                payload: jobPayload,
                attempt: 0,
                maxAttempts: 3,
                correlationId: initialRun.id,
                enqueuedAt: nowMs,
              });
              alertSent = true;
            } catch {
              // Delivery attempt failed
            }
          }
        }
      }

      if (alertSent) {
        alertMessageKey = candidateKey;
        await env.PLATFORM_DB.prepare(
          `UPDATE trust_watch_runs
           SET alert_sent = 1, alert_message_key = ?
           WHERE id = ?`,
        )
          .bind(alertMessageKey, initialRun.id)
          .run();
      } else {
        // Release claim slot immediately so subsequent runs retry instead of dropping the alert all day!
        await releaseDailyTrustWatchAlert(env.PLATFORM_DB, runDay, initialRun.id);
      }
    } else {
      alertDeduplicated = true;
      await env.PLATFORM_DB.prepare(
        `UPDATE trust_watch_runs
         SET alert_deduplicated = 1
         WHERE id = ?`,
      )
        .bind(initialRun.id)
        .run();
    }
  }

  logger(
    redactJobLogRecord({
      event: "trust_watch.completed",
      runId: initialRun.id,
      runDay,
      status,
      hostsCapped,
      checkedHostsCount: targets.length,
      resolvedHostsCount,
      failedHostsCount: failures.length,
      hitCount: hits.length,
      alertSent,
      alertDeduplicated,
      errorCode,
      timestamp: nowMs,
    }),
  );

  const finalRun: TrustWatchRunRecord = {
    ...initialRun,
    alertSent,
    alertDeduplicated,
    alertMessageKey,
  };

  return {
    run: finalRun,
    status,
    hostsCapped,
    alertSent,
    alertDeduplicated,
    hits,
    failures,
  };
}

export function createTrustWatchJobRegistry(
  options: Omit<RunDailyTrustWatchOptions, "nowMs"> = {},
): DurableJobRegistry {
  const handler: DurableJobHandler = {
    maxAttempts: 2,
    async execute(ctx) {
      const workerEnv = ctx.env as unknown as PunyasitusEnv & TrustWatchEnv;
      const emailPort =
        options.emailPort !== undefined
          ? options.emailPort
          : resolveEmailPort({
              cloudflareBinding: workerEnv.EMAIL ?? null,
              resendApiKey: workerEnv.RESEND_API_KEY ?? null,
            });
      await runDailyTrustWatch(workerEnv, {
        ...options,
        emailPort,
        jobsQueue:
          options.jobsQueue !== undefined ? options.jobsQueue : (workerEnv.JOBS_QUEUE ?? null),
        nowMs: ctx.nowMs,
      });
    },
  };
  return {
    [TRUST_WATCH_TOPIC]: handler,
  };
}

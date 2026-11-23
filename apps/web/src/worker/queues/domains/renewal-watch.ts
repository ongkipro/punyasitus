import {
  DAY_MS,
  DEFAULT_SAAS_CNAME_TARGET,
  createCloudflareDohDnsResolver,
  createCloudflareSaasClient,
  doesCnameMatchTarget,
  type CloudflareCustomHostname,
  type CloudflareSaasClient,
  type DnsResolverPort,
} from "@punyasitus/core/domains/index";
import {
  createLocalMailSink,
  renderEmailTemplate,
  resolveEmailPort,
  type CloudflareSendEmailBinding,
  type EmailPort,
} from "@punyasitus/core/email/index";
import { redactJobLogRecord } from "@punyasitus/core/jobs/index";
import {
  listActiveCustomHostnamesForRenewalWatch,
  recordRenewalWatchAlert,
  type ActiveCustomDomainWatchCandidate,
} from "@punyasitus/db/domains/index";
import type {
  DurableJobHandler,
  JobExecutionContext,
  StructuredJobLogger,
} from "../consumer.ts";

/**
 * Active Custom Domain Renewal-Watch Cron (REQ-004, REQ-043; PLAN §3.2).
 *
 * Monitors every active custom domain for:
 * - Missing or changed routing CNAME (no longer points to `cname.situsku.click`)
 * - Missing Delegated DCV CNAME on `_acme-challenge.<hostname>`
 * - Conflicting `_acme-challenge.<hostname>` TXT blocking renewal
 * - Degraded Cloudflare `ssl.status` or `status === "moved"`
 *
 * Sends a deduplicated Indonesian `domain-notice` email to the tenant owner (and agency owner)
 * via `EmailPort`, and stays strictly NON-FATAL on email delivery failures.
 */

export const DOMAIN_RENEWAL_WATCH_TOPIC = "domains.renewal_watch" as const;
export const DEFAULT_RENEWAL_ALERT_COOLDOWN_MS = DAY_MS; // 24 hours deduplication window

export type RenewalWatchIssueCode =
  | "CNAME_MISSING"
  | "DCV_DELEGATION_MISSING"
  | "CONFLICTING_ACME_TXT"
  | "SSL_RENEWAL_DEGRADED"
  | "HOSTNAME_MOVED";

export interface RenewalWatchDomainOutcome {
  readonly host: string;
  readonly tenantId: string;
  readonly healthy: boolean;
  readonly issues: readonly RenewalWatchIssueCode[];
  readonly alertAction: "none" | "sent" | "deduplicated" | "email_failed" | "no_recipients";
}

export interface DomainRenewalWatchResult {
  readonly checked: number;
  readonly healthy: number;
  readonly degraded: number;
  readonly alertsSent: number;
  readonly alertsDeduplicated: number;
  readonly emailFailures: number;
  readonly items: readonly RenewalWatchDomainOutcome[];
}

export interface RunDomainRenewalWatchOptions {
  readonly platformDb: D1Database;
  /** Defaults to production Cloudflare DoH resolver (`createCloudflareDohDnsResolver()`). */
  readonly dnsResolver?: DnsResolverPort;
  readonly emailPort: EmailPort;
  readonly cloudflareClient?: CloudflareSaasClient | null;
  readonly cnameTarget?: string;
  readonly platformDomain?: string;
  readonly nowMs?: number;
  readonly alertCooldownMs?: number;
  readonly limit?: number;
  readonly requestId?: string;
  readonly logger?: StructuredJobLogger;
}

export interface DomainRenewalWatchJobPayload {
  readonly nowMs?: number;
  readonly limit?: number;
}

function defaultLogger(entry: Record<string, unknown>): void {
  console.log(JSON.stringify(entry));
}

function extractDelegatedDcvExpectation(
  candidate: ActiveCustomDomainWatchCandidate,
  provider: CloudflareCustomHostname | null,
): { readonly name: string; readonly target: string } | null {
  const source = provider ?? candidate.providerSnapshot;
  for (const rec of source?.ssl.dcv_delegation_records ?? []) {
    if (rec.cname && rec.cname_target) {
      return {
        name: rec.cname.trim().toLowerCase().replace(/\.$/, ""),
        target: rec.cname_target.trim().toLowerCase().replace(/\.$/, ""),
      };
    }
  }
  for (const rec of source?.ssl.validation_records ?? []) {
    if (rec.cname && rec.cname_target) {
      return {
        name: rec.cname.trim().toLowerCase().replace(/\.$/, ""),
        target: rec.cname_target.trim().toLowerCase().replace(/\.$/, ""),
      };
    }
  }
  return null;
}

function buildIndonesianFixDetails(params: {
  readonly host: string;
  readonly cnameTarget: string;
  readonly issues: readonly RenewalWatchIssueCode[];
  readonly delegatedDcv: { readonly name: string; readonly target: string } | null;
}): string {
  const parts: string[] = [];
  if (params.issues.includes("CNAME_MISSING") || params.issues.includes("HOSTNAME_MOVED")) {
    parts.push(
      `Record CNAME untuk ${params.host} tidak lagi mengarah ke ${params.cnameTarget}. Segera arahkan kembali CNAME ${params.host} -> ${params.cnameTarget} agar website dan perpanjangan SSL tetap aktif.`,
    );
  }
  if (params.issues.includes("DCV_DELEGATION_MISSING")) {
    const recordDesc = params.delegatedDcv
      ? `${params.delegatedDcv.name} -> ${params.delegatedDcv.target}`
      : `_acme-challenge.${params.host}`;
    parts.push(
      `Record CNAME Delegated DCV (${recordDesc}) tidak ditemukan. Kembalikan record CNAME Delegated DCV tersebut sebelum sertifikat SSL kedaluwarsa.`,
    );
  }
  if (params.issues.includes("CONFLICTING_ACME_TXT")) {
    parts.push(
      `Ditemukan record TXT bentrok pada _acme-challenge.${params.host} yang menghalangi perpanjangan sertifikat SSL otomatis. Hapus record TXT tersebut.`,
    );
  }
  if (params.issues.includes("SSL_RENEWAL_DEGRADED")) {
    parts.push(
      `Status perpanjangan sertifikat SSL Cloudflare pada ${params.host} memerlukan tindakan. Buka pengaturan Domain dan klik "Periksa sekarang".`,
    );
  }
  return parts.join(" ").slice(0, 500);
}

export async function runDomainRenewalWatch(
  options: RunDomainRenewalWatchOptions,
): Promise<DomainRenewalWatchResult> {
  const nowMs = Math.trunc(options.nowMs ?? Date.now());
  const dnsResolver = options.dnsResolver ?? createCloudflareDohDnsResolver();
  const cnameTarget = (options.cnameTarget ?? DEFAULT_SAAS_CNAME_TARGET).trim().toLowerCase();
  const platformDomain = (options.platformDomain ?? "punyasitus.com").trim().toLowerCase();
  const alertCooldownMs = Math.max(
    60_000,
    options.alertCooldownMs ?? DEFAULT_RENEWAL_ALERT_COOLDOWN_MS,
  );
  const requestId = options.requestId ?? `renewal_watch_${nowMs}`;
  const logger = options.logger ?? defaultLogger;

  const candidates = await listActiveCustomHostnamesForRenewalWatch(options.platformDb, {
    limit: options.limit,
  });

  const items: RenewalWatchDomainOutcome[] = [];
  let healthy = 0;
  let degraded = 0;
  let alertsSent = 0;
  let alertsDeduplicated = 0;
  let emailFailures = 0;

  for (const candidate of candidates) {
    const issues: RenewalWatchIssueCode[] = [];

    // 1. Optional live Cloudflare status fetch
    let liveProvider: CloudflareCustomHostname | null = null;
    if (options.cloudflareClient && candidate.cfCustomHostnameId) {
      try {
        liveProvider = await options.cloudflareClient.getCustomHostname(
          candidate.cfCustomHostnameId,
        );
        const pStatus = liveProvider.status.toLowerCase();
        const pSsl = liveProvider.ssl.status.toLowerCase();
        if (pStatus === "moved") {
          issues.push("HOSTNAME_MOVED");
        }
        if (pSsl !== "active") {
          issues.push("SSL_RENEWAL_DEGRADED");
        }
      } catch {
        // Non-fatal: still run DNS checks even if Cloudflare status check temporarily fails
      }
    }

    // 2. Check routing CNAME target
    try {
      const observedCnames = await dnsResolver.resolveCname(candidate.host);
      if (!doesCnameMatchTarget(observedCnames, cnameTarget)) {
        issues.push("CNAME_MISSING");
      }
    } catch {
      issues.push("CNAME_MISSING");
    }

    // 3. Check Delegated DCV CNAME & conflicting `_acme-challenge` TXT when delegation is used
    const delegatedDcv = extractDelegatedDcvExpectation(candidate, liveProvider);
    if (delegatedDcv) {
      try {
        const dcvCnames = await dnsResolver.resolveCname(delegatedDcv.name);
        if (!doesCnameMatchTarget(dcvCnames, delegatedDcv.target)) {
          issues.push("DCV_DELEGATION_MISSING");
        }
      } catch {
        issues.push("DCV_DELEGATION_MISSING");
      }

      try {
        const acmeTxts = await dnsResolver.resolveTxt(delegatedDcv.name);
        if (acmeTxts.some((v) => v.trim().length > 0)) {
          issues.push("CONFLICTING_ACME_TXT");
        }
      } catch {
        // Ignore TXT lookup error when no TXT exists
      }
    }

    if (issues.length === 0) {
      healthy += 1;
      items.push({
        host: candidate.host,
        tenantId: candidate.tenantId,
        healthy: true,
        issues: [],
        alertAction: "none",
      });
      continue;
    }

    degraded += 1;
    const primaryIssue = issues[0]!;
    const issueSignature = [...issues].sort().join("+");
    const alertKey = `${candidate.host}:${issueSignature}`;

    // Deduplicate repeated alerts within cooldown window for the same issue signature
    const withinCooldown =
      candidate.lastRenewalAlertKey === alertKey &&
      candidate.lastRenewalAlertAt !== null &&
      nowMs - candidate.lastRenewalAlertAt < alertCooldownMs;

    if (withinCooldown) {
      alertsDeduplicated += 1;
      items.push({
        host: candidate.host,
        tenantId: candidate.tenantId,
        healthy: false,
        issues,
        alertAction: "deduplicated",
      });
      continue;
    }

    if (candidate.ownerEmails.length === 0) {
      await recordRenewalWatchAlert(options.platformDb, {
        host: candidate.host,
        tenantId: candidate.tenantId,
        alertKey,
        issueCode: primaryIssue,
        emailOutcome: "skipped",
        requestId,
        nowMs,
      });
      items.push({
        host: candidate.host,
        tenantId: candidate.tenantId,
        healthy: false,
        issues,
        alertAction: "no_recipients",
      });
      continue;
    }

    const noticeStatus =
      issues.includes("HOSTNAME_MOVED")
        ? ("moved" as const)
        : issues.includes("CNAME_MISSING") || issues.includes("DCV_DELEGATION_MISSING")
          ? ("pending_dns" as const)
          : ("failed" as const);

    const details = buildIndonesianFixDetails({
      host: candidate.host,
      cnameTarget,
      issues,
      delegatedDcv,
    });
    const dashboardUrl = `https://app.${platformDomain}/dashboard/${candidate.tenantHandle}/domains`;
    const dayBucket = Math.floor(nowMs / alertCooldownMs);

    let anySent = false;
    let anyFailed = false;

    for (const recipient of candidate.ownerEmails) {
      try {
        const rendered = renderEmailTemplate("domain-notice", {
          recipientName: recipient.name,
          tenantName: candidate.tenantName,
          domain: candidate.host,
          status: noticeStatus,
          details,
          dashboardUrl,
        });

        const sendRes = await options.emailPort.send({
          messageKey: `domain-renewal-watch:${candidate.tenantId}:${candidate.host}:${issueSignature}:${dayBucket}:${recipient.email}`,
          template: "domain-notice",
          to: recipient.email,
          subject: rendered.subject,
          html: rendered.html,
          text: rendered.text,
          tenantId: candidate.tenantId,
        });

        if (sendRes.outcome === "submitted") {
          anySent = true;
        } else {
          anyFailed = true;
        }
      } catch {
        // Non-fatal on email delivery failure (PLAN §3.2 & TASK-003)
        anyFailed = true;
      }
    }

    const emailOutcome: "submitted" | "failed" = anySent ? "submitted" : "failed";
    await recordRenewalWatchAlert(options.platformDb, {
      host: candidate.host,
      tenantId: candidate.tenantId,
      alertKey,
      issueCode: primaryIssue,
      emailOutcome,
      requestId,
      nowMs,
    });

    if (anySent) {
      alertsSent += 1;
    }
    if (anyFailed && !anySent) {
      emailFailures += 1;
    }

    items.push({
      host: candidate.host,
      tenantId: candidate.tenantId,
      healthy: false,
      issues,
      alertAction: anySent ? "sent" : "email_failed",
    });
  }

  logger(
    redactJobLogRecord({
      event: "domains.renewal_watch.completed",
      requestId,
      checked: candidates.length,
      healthy,
      degraded,
      alertsSent,
      alertsDeduplicated,
      emailFailures,
      timestamp: nowMs,
    }),
  );

  return {
    checked: candidates.length,
    healthy,
    degraded,
    alertsSent,
    alertsDeduplicated,
    emailFailures,
    items,
  };
}

export interface CreateDomainRenewalWatchQueueHandlerOptions {
  readonly dnsResolver?: DnsResolverPort;
  readonly emailPort?: EmailPort;
  readonly cloudflareClient?: CloudflareSaasClient | null;
  readonly cnameTarget?: string;
  readonly platformDomain?: string;
  readonly alertCooldownMs?: number;
  readonly logger?: StructuredJobLogger;
  readonly onCompleted?: (result: DomainRenewalWatchResult) => Promise<void> | void;
}

function resolveRenewalWatchCloudflareClient(
  env: JobExecutionContext["env"],
  explicit?: CloudflareSaasClient | null,
): CloudflareSaasClient | null {
  if (explicit !== undefined) return explicit;
  const cfEnv = env as typeof env & {
    readonly CF_SAAS_ZONE_ID?: string;
    readonly CF_SAAS_API_TOKEN?: string;
    readonly CF_API_BASE_URL?: string;
  };
  const zoneId = cfEnv.CF_SAAS_ZONE_ID?.trim() ?? "";
  const apiToken = cfEnv.CF_SAAS_API_TOKEN?.trim() ?? "";
  if (!zoneId || !apiToken) return null;
  return createCloudflareSaasClient({
    zoneId,
    apiToken,
    apiBaseUrl: cfEnv.CF_API_BASE_URL,
  });
}

function resolveRenewalWatchEmailPort(
  env: JobExecutionContext["env"],
  explicit?: EmailPort,
): EmailPort {
  if (explicit) return explicit;
  const emailEnv = env as typeof env & {
    readonly EMAIL?: CloudflareSendEmailBinding;
    readonly RESEND_API_KEY?: string;
  };
  if (emailEnv.EMAIL || emailEnv.RESEND_API_KEY) {
    return (
      resolveEmailPort({
        cloudflareBinding: emailEnv.EMAIL,
        resendApiKey: emailEnv.RESEND_API_KEY,
      }) ?? createLocalMailSink()
    );
  }
  return createLocalMailSink();
}

export function createDomainRenewalWatchQueueHandler(
  options: CreateDomainRenewalWatchQueueHandlerOptions = {},
): DurableJobHandler<DomainRenewalWatchJobPayload> {
  return {
    maxAttempts: 3,
    leaseDurationMs: 120_000,
    async execute(ctx: JobExecutionContext<DomainRenewalWatchJobPayload>): Promise<void> {
      const payload = ctx.payload ?? {};
      const nowMs =
        typeof payload.nowMs === "number" && Number.isFinite(payload.nowMs)
          ? Math.trunc(payload.nowMs)
          : ctx.nowMs;
      const result = await runDomainRenewalWatch({
        platformDb: ctx.env.PLATFORM_DB,
        dnsResolver: options.dnsResolver ?? createCloudflareDohDnsResolver(),
        emailPort: resolveRenewalWatchEmailPort(ctx.env, options.emailPort),
        cloudflareClient: resolveRenewalWatchCloudflareClient(ctx.env, options.cloudflareClient),
        cnameTarget: options.cnameTarget,
        platformDomain: options.platformDomain ?? ctx.env.PLATFORM_DOMAIN,
        nowMs,
        alertCooldownMs: options.alertCooldownMs,
        limit: payload.limit,
        requestId: ctx.correlationId ?? ctx.idempotencyKey,
        logger: options.logger,
      });
      if (options.onCompleted) {
        await options.onCompleted(result);
      }
    },
  };
}

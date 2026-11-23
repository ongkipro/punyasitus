import type { CloudflareCustomHostname } from "./cloudflare-client.ts";
import {
  DEFAULT_SAAS_CNAME_TARGET,
  type DomainConnectMode,
  type DomainSslMethod,
} from "./validation.ts";

/**
 * 3 Connect Modes instruction builder (PLAN §3.2), DCV token age/expiry calculator,
 * and Indonesian diagnostic remedies engine (REQ-004, REQ-043, DEC-040).
 *
 * Non-negotiable invariants:
 * - NEVER fabricate ownership TXT tokens, DCV TXT tokens, or Delegated DCV CNAME targets.
 *   Every verification record value comes strictly from the Cloudflare provider response.
 * - Mode B (`zero_downtime_migration`) keeps the CNAME cutover step LOCKED until BOTH
 *   `provider.status === "active"` AND `provider.ssl.status === "active"`.
 * - Mode C (`cloudflare_o2o`) enforces create-before-CNAME: refuses to emit the CNAME step
 *   until the custom hostname exists at Cloudflare (`provider.id` present).
 * - Token lifetimes: Let's Encrypt = 7 days (168h), Google Trust Services / SSL.com = 14 days (336h);
 *   day-5 warning at >= 5 days (120h); expired tokens trigger re-fetch.
 */

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;

export const DCV_TOKEN_WARNING_DAYS = 5 as const;
export const DCV_TOKEN_WARNING_MS = DCV_TOKEN_WARNING_DAYS * DAY_MS; // 120h

export const LETS_ENCRYPT_TOKEN_TTL_DAYS = 7 as const;
export const GOOGLE_TRUST_TOKEN_TTL_DAYS = 14 as const;
export const SSL_COM_TOKEN_TTL_DAYS = 14 as const;

export type KnownCertificateAuthority = "lets_encrypt" | "google" | "ssl_com" | "unknown";

export interface DcvTokenAgeAssessment {
  readonly certificateAuthority: KnownCertificateAuthority;
  readonly ttlDays: 7 | 14;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  readonly expiresAtIso: string;
  readonly ageMs: number;
  readonly ageHours: number;
  readonly ageDays: number;
  readonly warningDay5: boolean;
  readonly expired: boolean;
  readonly needsRefetch: boolean;
  readonly warningMessageId: string | null;
}

export interface DomainValidationInstructionRecord {
  readonly recordType: "CNAME" | "TXT";
  readonly name: string;
  readonly value: string;
  readonly purpose: "ownership" | "ssl_dcv" | "routing";
  readonly status: "pending" | "verified" | "conflict" | "expired";
  readonly removableAfterActive: boolean;
}

export interface DnsObservationSnapshot {
  readonly cnameTargets?: readonly string[];
  readonly acmeChallengeTxtRecords?: readonly string[];
  readonly acmeChallengeCnameTargets?: readonly string[];
  readonly caaRecords?: readonly string[];
}

export type DomainRemedyCode =
  | "CONFLICTING_ACME_CHALLENGE_TXT"
  | "CAA_BLOCKED"
  | "HOSTNAME_BLOCKED"
  | "HOSTNAME_MOVED"
  | "HTTP_DCV_BLOCKED"
  | "DCV_PENDING"
  | "DNS_TARGET_MISMATCH"
  | "O2O_SSL_MODE_REMINDER"
  | "DCV_TOKEN_EXPIRING_SOON"
  | "DCV_TOKEN_EXPIRED"
  | "AWAITING_PROVIDER_TOKENS";

export interface DomainRemedy {
  readonly code: DomainRemedyCode;
  readonly severity: "info" | "warning" | "error";
  readonly titleId: string;
  readonly messageId: string;
  readonly actionHintId: string;
  readonly affectedRecord?: string;
  readonly conflictingValues?: readonly string[];
  readonly suggestedSslMethod?: DomainSslMethod;
}

export interface ConnectStepInstruction {
  readonly stepNumber: number;
  readonly key: string;
  readonly titleId: string;
  readonly descriptionId: string;
  readonly locked: boolean;
  readonly completed: boolean;
  readonly records: readonly DomainValidationInstructionRecord[];
}

export interface ConnectModeInstructionPlan {
  readonly mode: DomainConnectMode;
  readonly sslMethod: DomainSslMethod;
  readonly hostname: string;
  readonly cnameTarget: string;
  readonly createBeforeCnameSatisfied: boolean;
  readonly cnameCutoverLocked: boolean;
  readonly readyForCutover: boolean;
  readonly awaitingProviderTokens: boolean;
  readonly validationRecords: readonly DomainValidationInstructionRecord[];
  readonly steps: readonly ConnectStepInstruction[];
  readonly noticesId: readonly string[];
  readonly tokenAge: DcvTokenAgeAssessment | null;
  readonly remedies: readonly DomainRemedy[];
}

export function normalizeCertificateAuthority(raw?: string | null): KnownCertificateAuthority {
  if (!raw) return "unknown";
  const cleaned = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (cleaned === "lets_encrypt" || cleaned === "letsencrypt") return "lets_encrypt";
  if (cleaned === "google" || cleaned === "google_trust_services" || cleaned === "gts") {
    return "google";
  }
  if (cleaned === "ssl_com" || cleaned === "sslcom" || cleaned === "ssl.com") return "ssl_com";
  return "unknown";
}

export function getTokenTtlDaysForCa(ca: KnownCertificateAuthority): 7 | 14 {
  if (ca === "google") return GOOGLE_TRUST_TOKEN_TTL_DAYS;
  if (ca === "ssl_com") return SSL_COM_TOKEN_TTL_DAYS;
  // Let's Encrypt & unknown/default CA use conservative 7-day shortest lifetime (PLAN §3.2)
  return LETS_ENCRYPT_TOKEN_TTL_DAYS;
}

/**
 * Computes DCV token age, Day-5 warning, and CA-specific expiry (PLAN §3.2):
 * - Let's Encrypt: 7 days (168h)
 * - Google Trust Services & SSL.com: 14 days (336h)
 * - Warning triggered at day 5 (>= 120h) for all CAs.
 */
export function evaluateDcvTokenAge(input: {
  readonly certificateAuthority?: string | null;
  readonly issuedAtMs: number;
  readonly nowMs: number;
}): DcvTokenAgeAssessment {
  const ca = normalizeCertificateAuthority(input.certificateAuthority);
  const ttlDays = getTokenTtlDaysForCa(ca);
  const ttlMs = ttlDays * DAY_MS;
  const issuedAtMs = Math.trunc(input.issuedAtMs);
  const nowMs = Math.trunc(input.nowMs);
  const ageMs = Math.max(0, nowMs - issuedAtMs);
  const ageHours = Math.floor(ageMs / HOUR_MS);
  const ageDays = Math.floor(ageMs / DAY_MS);
  const expiresAtMs = issuedAtMs + ttlMs;
  const expiresAtIso = new Date(expiresAtMs).toISOString();
  const expired = nowMs >= expiresAtMs;
  const warningDay5 = ageMs >= DCV_TOKEN_WARNING_MS;

  const caLabel =
    ca === "google"
      ? "Google Trust Services (14 hari)"
      : ca === "ssl_com"
        ? "SSL.com (14 hari)"
        : "Let's Encrypt (7 hari)";

  let warningMessageId: string | null = null;
  if (expired) {
    warningMessageId = `Token verifikasi SSL telah kedaluwarsa setelah ${ttlDays} hari (${caLabel}). Sistem perlu mengambil ulang token DCV terbaru.`;
  } else if (warningDay5) {
    warningMessageId = `Peringatan hari ke-${ageDays}: token verifikasi SSL akan segera kedaluwarsa (${caLabel}). Segera selesaikan pengaturan DNS atau klik "Periksa sekarang".`;
  }

  return {
    certificateAuthority: ca,
    ttlDays,
    issuedAtMs,
    expiresAtMs,
    expiresAtIso,
    ageMs,
    ageHours,
    ageDays,
    warningDay5,
    expired,
    needsRefetch: expired,
    warningMessageId,
  };
}

function normalizeDnsTarget(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

export function doesCnameMatchTarget(
  observedTargets: readonly string[] | undefined,
  expectedTarget: string,
): boolean {
  if (!observedTargets || observedTargets.length === 0) return false;
  const expected = normalizeDnsTarget(expectedTarget);
  return observedTargets.some((t) => normalizeDnsTarget(t) === expected);
}

function extractValidationErrorMessages(provider: CloudflareCustomHostname | null): string[] {
  if (!provider) return [];
  const out: string[] = [];
  for (const err of provider.verification_errors ?? []) {
    if (err.trim()) out.push(err.trim());
  }
  for (const err of provider.ssl.validation_errors ?? []) {
    if (err.message?.trim()) out.push(err.message.trim());
  }
  return out;
}

function caaBlocksCloudflareIssuance(caaRecords: readonly string[] | undefined): boolean {
  if (!caaRecords || caaRecords.length === 0) return false;
  const issueDirectives = caaRecords
    .map((r) => r.trim().toLowerCase())
    .filter((r) => /\bissue\b/.test(r) && !/\biodef\b/.test(r));
  if (issueDirectives.length === 0) return false;

  const cfAllowedCas = ["pki.goog", "letsencrypt.org", "ssl.com", "digicert.com"];
  return !issueDirectives.some((entry) => cfAllowedCas.some((ca) => entry.includes(ca)));
}

/**
 * Detects DNS/provider blockers and emits clear Indonesian remedies (PLAN §3.1, §3.2, §12.2).
 */
export function diagnoseDomainState(input: {
  readonly hostname: string;
  readonly mode: DomainConnectMode;
  readonly cnameTarget?: string;
  readonly provider: CloudflareCustomHostname | null;
  readonly dns?: DnsObservationSnapshot;
  readonly tokenAge?: DcvTokenAgeAssessment | null;
}): readonly DomainRemedy[] {
  const remedies: DomainRemedy[] = [];
  const cnameTarget = normalizeDnsTarget(input.cnameTarget ?? DEFAULT_SAAS_CNAME_TARGET);
  const provider = input.provider;
  const dns = input.dns;
  const acmeRecordName = `_acme-challenge.${input.hostname}`;

  const providerStatus = provider?.status.toLowerCase() ?? "pending";
  const sslStatus = provider?.ssl.status.toLowerCase() ?? "pending_validation";
  const allErrors = extractValidationErrorMessages(provider);
  const joinedErrors = allErrors.join(" | ").toLowerCase();

  // 1. Conflicting `_acme-challenge.<hostname>` TXT detection (PLAN §3.2)
  const expectedDcvTxtValues = new Set<string>();
  let hasDelegatedDcvCname = false;
  for (const rec of provider?.ssl.dcv_delegation_records ?? []) {
    if (rec.cname && rec.cname_target) hasDelegatedDcvCname = true;
  }
  for (const rec of provider?.ssl.validation_records ?? []) {
    if (rec.cname && rec.cname_target) hasDelegatedDcvCname = true;
    if (rec.txt_value) expectedDcvTxtValues.add(rec.txt_value.trim());
  }

  const observedAcmeTxts = (dns?.acmeChallengeTxtRecords ?? [])
    .map((v) => v.trim())
    .filter(Boolean);

  if (observedAcmeTxts.length > 0) {
    // Under Delegated DCV CNAME, ANY `_acme-challenge` TXT conflicts with CNAME!
    // Under TXT DCV, any TXT value that does NOT match provider's expected token is a conflicting TXT!
    const conflictingValues = hasDelegatedDcvCname
      ? observedAcmeTxts
      : observedAcmeTxts.filter((val) => !expectedDcvTxtValues.has(val));

    if (conflictingValues.length > 0) {
      remedies.push({
        code: "CONFLICTING_ACME_CHALLENGE_TXT",
        severity: "error",
        titleId: `Record TXT bentrok ditemukan pada ${acmeRecordName}`,
        messageId: `Ditemukan record TXT lama atau bentrok pada ${acmeRecordName} yang menghalangi validasi sertifikat SSL (termasuk Delegated DCV).`,
        actionHintId: `Hapus record TXT bentrok pada ${acmeRecordName} di panel DNS Anda (termasuk zona Cloudflare milik Anda jika ada), lalu klik "Periksa sekarang".`,
        affectedRecord: acmeRecordName,
        conflictingValues,
      });
    }
  }

  // 2. CAA blocking detection (provider error or observed CAA DNS records)
  const hasCaaError =
    /\bcaa\b/i.test(joinedErrors) || caaBlocksCloudflareIssuance(dns?.caaRecords);
  if (hasCaaError) {
    remedies.push({
      code: "CAA_BLOCKED",
      severity: "error",
      titleId: "Record DNS CAA memblokir penerbitan sertifikat SSL",
      messageId:
        "Record CAA pada domain Anda tidak mengizinkan CA yang digunakan Cloudflare (Google Trust Services / Let's Encrypt). Mengganti metode validasi HTTP/TXT tidak menyelesaikan blokir CAA.",
      actionHintId: `Tambahkan record CAA yang mengizinkan "pki.goog" dan "letsencrypt.org" (atau hapus record CAA yang membatasi) pada domain ${input.hostname}, lalu klik "Periksa sekarang".`,
      affectedRecord: input.hostname,
    });
  }

  // 3. Hostname Blocked (Cloudflare Zone Hold / abuse)
  if (providerStatus === "blocked") {
    remedies.push({
      code: "HOSTNAME_BLOCKED",
      severity: "error",
      titleId: "Hostname diblokir (Zone Hold / pembatasan Cloudflare)",
      messageId:
        "Status hostname di Cloudflare adalah Blocked dan tidak akan diulang otomatis. Penyebab umumnya adalah fitur Zone Hold pada akun Cloudflare pemilik domain.",
      actionHintId:
        'Lepaskan Zone Hold (termasuk opsi "Also prevent subdomains") di dashboard Cloudflare Anda, lalu klik "Periksa sekarang" untuk memulai ulang validasi.',
      affectedRecord: input.hostname,
    });
  }

  // 4. Hostname Moved
  if (providerStatus === "moved") {
    remedies.push({
      code: "HOSTNAME_MOVED",
      severity: "error",
      titleId: "Domain berpindah (Moved) karena DNS tidak lagi mengarah ke PunyaSitus",
      messageId: `Cloudflare mendeteksi ${input.hostname} tidak lagi mengarah ke ${cnameTarget}. Hostname berstatus moved lebih dari 7 hari akan dibersihkan otomatis.`,
      actionHintId: `Arahkan kembali record CNAME ${input.hostname} ke ${cnameTarget}, lalu klik "Periksa sekarang".`,
      affectedRecord: input.hostname,
    });
  }

  // 5. HTTP DCV blocked / unreachable -> recommend PATCH ssl.method = "txt"
  const httpDcvBlocked =
    provider?.ssl.method === "http" &&
    sslStatus !== "active" &&
    (/(?:http|403|404|redirect|waf|firewall|challenge|timed?\s*out|unreachable)/i.test(
      joinedErrors,
    ) ||
      sslStatus === "validation_timed_out");
  if (httpDcvBlocked) {
    remedies.push({
      code: "HTTP_DCV_BLOCKED",
      severity: "warning",
      titleId: "Validasi SSL HTTP terhalang WAF/redirect",
      messageId:
        "Cloudflare gagal mengakses jalur validasi HTTP (/.well-known/acme-challenge/ atau /.well-known/pki-validation/) karena aturan redirect, WAF, atau konfigurasi proxy.",
      actionHintId:
        'Ubah metode validasi SSL ke TXT (PATCH ssl.method = "txt") atau matikan sementara blokir WAF untuk /.well-known/*, lalu klik "Periksa sekarang".',
      affectedRecord: input.hostname,
      suggestedSslMethod: "txt",
    });
  } else if (
    sslStatus !== "active" &&
    providerStatus !== "blocked" &&
    !hasCaaError &&
    provider !== null
  ) {
    remedies.push({
      code: "DCV_PENDING",
      severity: "info",
      titleId: "Validasi sertifikat SSL (DCV) sedang berlangsung",
      messageId:
        "Cloudflare sedang memverifikasi kepemilikan sertifikat SSL secara berkala. Pastikan record DNS sudah tersimpan tanpa typo.",
      actionHintId:
        'Tunggu propagasi DNS beberapa menit atau klik "Periksa sekarang" untuk memicu pengecekan ulang langsung.',
      affectedRecord: input.hostname,
    });
  }

  // 6. DNS target mismatch (skip in migration mode before pre-validation completes!)
  const preValidationComplete = providerStatus === "active" && sslStatus === "active";
  const expectsCnameNow = input.mode !== "zero_downtime_migration" || preValidationComplete;
  const cnameMismatchError = /does not cname to this zone|cname/i.test(joinedErrors);
  const dnsObservedMismatch =
    dns?.cnameTargets !== undefined && !doesCnameMatchTarget(dns.cnameTargets, cnameTarget);

  if (expectsCnameNow && (cnameMismatchError || dnsObservedMismatch)) {
    remedies.push({
      code: "DNS_TARGET_MISMATCH",
      severity: "warning",
      titleId: "Target CNAME belum mengarah ke PunyaSitus",
      messageId: `Record CNAME untuk ${input.hostname} belum mengarah ke ${cnameTarget}.`,
      actionHintId: `Buat atau perbarui record CNAME ${input.hostname} -> ${cnameTarget} di penyedia DNS Anda.`,
      affectedRecord: input.hostname,
    });
  }

  // 7. O2O SSL/TLS mode reminder
  if (input.mode === "cloudflare_o2o") {
    remedies.push({
      code: "O2O_SSL_MODE_REMINDER",
      severity: "info",
      titleId: "Pengaturan wajib Cloudflare O2O (Full / Full Strict)",
      messageId:
        "Karena domain Anda sudah menggunakan Cloudflare, mode SSL/TLS Flexible dapat menyebabkan redirect loop. Custom hostname telah didaftarkan sebelum CNAME untuk mencegah Error 1014.",
      actionHintId:
        'Pastikan mode SSL/TLS di zona Cloudflare Anda diatur ke "Full" atau "Full (strict)" dan proxy (awan oranye) aktif pada CNAME.',
      affectedRecord: input.hostname,
    });
  }

  // 8. Token age warnings & expiry
  if (input.tokenAge && sslStatus !== "active") {
    if (input.tokenAge.expired) {
      remedies.push({
        code: "DCV_TOKEN_EXPIRED",
        severity: "error",
        titleId: "Token verifikasi SSL telah kedaluwarsa",
        messageId:
          input.tokenAge.warningMessageId ??
          "Token validasi DCV telah kedaluwarsa dan perlu diambil ulang.",
        actionHintId:
          'Klik "Periksa sekarang" untuk mengambil ulang token DCV terbaru dari Cloudflare dan perbarui record DNS Anda.',
        affectedRecord: acmeRecordName,
      });
    } else if (input.tokenAge.warningDay5) {
      remedies.push({
        code: "DCV_TOKEN_EXPIRING_SOON",
        severity: "warning",
        titleId: `Token verifikasi SSL berumur ${input.tokenAge.ageDays} hari`,
        messageId:
          input.tokenAge.warningMessageId ??
          "Token validasi DCV mendekati masa kedaluwarsa.",
        actionHintId:
          'Segera selesaikan pengaturan record DNS sebelum token kedaluwarsa, lalu klik "Periksa sekarang".',
        affectedRecord: acmeRecordName,
      });
    }
  }

  return remedies;
}

/**
 * Builds exact PLAN §3.2 DNS instructions for the 3 connect modes using STRICTLY
 * provider-returned records (zero fabricated tokens!).
 */
export function buildConnectInstructions(input: {
  readonly hostname: string;
  readonly mode: DomainConnectMode;
  readonly sslMethod: DomainSslMethod;
  readonly cnameTarget?: string;
  readonly provider: CloudflareCustomHostname | null;
  readonly dns?: DnsObservationSnapshot;
  readonly tokenIssuedAtMs?: number | null;
  readonly nowMs?: number;
}): ConnectModeInstructionPlan {
  const cnameTarget = normalizeDnsTarget(input.cnameTarget ?? DEFAULT_SAAS_CNAME_TARGET);
  const nowMs = Math.trunc(input.nowMs ?? Date.now());
  const provider = input.provider;
  const providerStatus = provider?.status.toLowerCase() ?? "pending";
  const providerSslStatus = provider?.ssl.status.toLowerCase() ?? "pending_validation";
  const createBeforeCnameSatisfied = Boolean(provider && provider.id.trim().length > 0);
  const cnameMatches = doesCnameMatchTarget(input.dns?.cnameTargets, cnameTarget);

  const tokenAge =
    input.tokenIssuedAtMs !== undefined && input.tokenIssuedAtMs !== null
      ? evaluateDcvTokenAge({
          certificateAuthority: provider?.ssl.certificate_authority,
          issuedAtMs: input.tokenIssuedAtMs,
          nowMs,
        })
      : null;

  const remedies = [
    ...diagnoseDomainState({
      hostname: input.hostname,
      mode: input.mode,
      cnameTarget,
      provider,
      dns: input.dns,
      tokenAge,
    }),
  ];

  const hasAcmeConflict = remedies.some((r) => r.code === "CONFLICTING_ACME_CHALLENGE_TXT");
  const isTokenExpired = Boolean(tokenAge?.expired && providerSslStatus !== "active");

  const routingCnameRecord: DomainValidationInstructionRecord = {
    recordType: "CNAME",
    name: input.hostname,
    value: cnameTarget,
    purpose: "routing",
    status: cnameMatches ? "verified" : "pending",
    removableAfterActive: false,
  };

  // Extract strictly provider-supplied ownership & DCV records (NEVER fabricated!)
  const providerOwnershipRecords: DomainValidationInstructionRecord[] = [];
  if (provider?.ownership_verification?.name && provider?.ownership_verification?.value) {
    providerOwnershipRecords.push({
      recordType: "TXT",
      name: provider.ownership_verification.name,
      value: provider.ownership_verification.value,
      purpose: "ownership",
      status: providerStatus === "active" ? "verified" : "pending",
      removableAfterActive: true, // PLAN §3.2: Ownership TXT can be removed after hostname is active
    });
  }

  const providerDcvRecords: DomainValidationInstructionRecord[] = [];
  const dcvStatus: DomainValidationInstructionRecord["status"] =
    providerSslStatus === "active"
      ? "verified"
      : hasAcmeConflict
        ? "conflict"
        : isTokenExpired
          ? "expired"
          : "pending";

  // Preferred: Delegated DCV CNAME from `dcv_delegation_records` or `validation_records`
  for (const rec of provider?.ssl.dcv_delegation_records ?? []) {
    if (rec.cname && rec.cname_target) {
      providerDcvRecords.push({
        recordType: "CNAME",
        name: rec.cname,
        value: rec.cname_target,
        purpose: "ssl_dcv",
        status: dcvStatus,
        removableAfterActive: false, // PLAN §3.2: Delegated DCV CNAME MUST stay for renewals!
      });
    }
  }

  for (const rec of provider?.ssl.validation_records ?? []) {
    if (rec.cname && rec.cname_target) {
      const dup = providerDcvRecords.some(
        (existing) => existing.recordType === "CNAME" && existing.name === rec.cname,
      );
      if (!dup) {
        providerDcvRecords.push({
          recordType: "CNAME",
          name: rec.cname,
          value: rec.cname_target,
          purpose: "ssl_dcv",
          status: dcvStatus,
          removableAfterActive: false,
        });
      }
    } else if (rec.txt_name && rec.txt_value) {
      providerDcvRecords.push({
        recordType: "TXT",
        name: rec.txt_name,
        value: rec.txt_value,
        purpose: "ssl_dcv",
        status: dcvStatus,
        removableAfterActive: true,
      });
    }
  }

  // Mode A: Domain baru (PLAN §3.2)
  if (input.mode === "new_domain") {
    const validationRecords: DomainValidationInstructionRecord[] = createBeforeCnameSatisfied
      ? [routingCnameRecord, ...providerDcvRecords]
      : [];
    const awaitingProviderTokens = !createBeforeCnameSatisfied;
    if (awaitingProviderTokens) {
      remedies.push({
        code: "AWAITING_PROVIDER_TOKENS",
        severity: "info",
        titleId: "Menunggu registrasi hostname dari Cloudflare",
        messageId: "Custom hostname sedang didaftarkan ke Cloudflare sebelum instruksi DNS ditampilkan.",
        actionHintId: 'Klik "Periksa sekarang" beberapa saat lagi untuk menyinkronkan status.',
      });
    }

    return {
      mode: "new_domain",
      sslMethod: input.sslMethod,
      hostname: input.hostname,
      cnameTarget,
      createBeforeCnameSatisfied,
      cnameCutoverLocked: !createBeforeCnameSatisfied,
      readyForCutover: createBeforeCnameSatisfied,
      awaitingProviderTokens,
      validationRecords,
      steps: [
        {
          stepNumber: 1,
          key: "add_cname",
          titleId: "Tambahkan record CNAME",
          descriptionId: `Buat record CNAME ${input.hostname} mengarah ke ${cnameTarget}.`,
          locked: !createBeforeCnameSatisfied,
          completed: cnameMatches,
          records: createBeforeCnameSatisfied ? [routingCnameRecord] : [],
        },
        {
          stepNumber: 2,
          key: "wait_active",
          titleId: "Tunggu status kepemilikan dan SSL aktif",
          descriptionId:
            "Akan ada jeda singkat penerbitan sertifikat SSL otomatis setelah CNAME diarahkan (wajar karena belum ada situs live pada domain ini).",
          locked: false,
          completed: providerStatus === "active" && providerSslStatus === "active",
          records: providerDcvRecords,
        },
      ],
      noticesId: [
        "Mode Domain baru cocok untuk domain yang belum memiliki situs live; jeda singkat penerbitan TLS setelah CNAME tersimpan adalah wajar.",
        "Untuk root/apex domain tanpa www, pastikan penyedia DNS Anda mendukung CNAME flattening/ALIAS/ANAME; jika tidak, gunakan www.<domain> sebagai domain utama.",
      ],
      tokenAge,
      remedies,
    };
  }

  // Mode B: Pindahan, nol downtime (PLAN §3.2)
  if (input.mode === "zero_downtime_migration") {
    const preValidationActive = providerStatus === "active" && providerSslStatus === "active";
    const cnameCutoverLocked = !preValidationActive;
    const preValidationRecords = [...providerOwnershipRecords, ...providerDcvRecords];
    const awaitingProviderTokens =
      !createBeforeCnameSatisfied ||
      (!preValidationActive &&
        (providerOwnershipRecords.length === 0 || providerDcvRecords.length === 0));

    if (awaitingProviderTokens) {
      remedies.push({
        code: "AWAITING_PROVIDER_TOKENS",
        severity: "info",
        titleId: "Menunggu token pre-validasi dari Cloudflare",
        messageId:
          "Token kepemilikan TXT dan/atau token validasi sertifikat DCV belum tersedia dari Cloudflare. PunyaSitus tidak pernah membuat token palsu secara lokal.",
        actionHintId: 'Tunggu beberapa detik lalu klik "Periksa sekarang" untuk mengambil token resmi Cloudflare.',
      });
    }

    // CRITICAL INVARIANT (PLAN §3.2 & TASK-003):
    // Keep CNAME cutover step & routing record strictly LOCKED until BOTH status & ssl.status === "active"!
    const validationRecords: DomainValidationInstructionRecord[] = cnameCutoverLocked
      ? preValidationRecords
      : [...preValidationRecords, routingCnameRecord];

    return {
      mode: "zero_downtime_migration",
      sslMethod: "txt",
      hostname: input.hostname,
      cnameTarget,
      createBeforeCnameSatisfied,
      cnameCutoverLocked,
      readyForCutover: preValidationActive,
      awaitingProviderTokens,
      validationRecords,
      steps: [
        {
          stepNumber: 1,
          key: "pre_validation_records",
          titleId: "Tambahkan record pre-validasi (situs lama tetap berjalan)",
          descriptionId:
            "Tambahkan TXT kepemilikan (_cf-custom-hostname) dan record DCV sertifikat (_acme-challenge) dari Cloudflare sementara situs lama Anda tetap live.",
          locked: false,
          completed: preValidationActive,
          records: preValidationRecords,
        },
        {
          stepNumber: 2,
          key: "wait_pre_validation",
          titleId: "Tunggu status hostname dan SSL keduanya aktif",
          descriptionId:
            "Langkah pemindahan CNAME tetap terkunci sampai status kepemilikan dan status sertifikat SSL keduanya berstatus active.",
          locked: false,
          completed: preValidationActive,
          records: [],
        },
        {
          stepNumber: 3,
          key: "cutover_cname",
          titleId: cnameCutoverLocked
            ? "Terkunci: Pindahkan CNAME (menunggu kepemilikan & SSL aktif)"
            : "Siap pindah: Arahkan CNAME ke PunyaSitus",
          descriptionId: cnameCutoverLocked
            ? "Langkah ini dikunci untuk mencegah downtime / error TLS. Tunggu hingga kepemilikan dan sertifikat SSL keduanya aktif."
            : `Kepemilikan dan SSL sudah aktif! Sekarang ubah CNAME ${input.hostname} ke ${cnameTarget} tanpa downtime. Untuk rollback, cukup kembalikan CNAME ke target lama.`,
          locked: cnameCutoverLocked,
          completed: !cnameCutoverLocked && cnameMatches,
          records: cnameCutoverLocked ? [] : [routingCnameRecord],
        },
      ],
      noticesId: [
        "TXT kepemilikan (_cf-custom-hostname) boleh dihapus setelah domain aktif, sedangkan CNAME Delegated DCV (_acme-challenge) WAJIB dipertahankan untuk perpanjangan SSL otomatis.",
        "Situs lama Anda tetap berjalan normal selama langkah 1 dan 2. Langkah 3 (cutover CNAME) terbuka otomatis hanya setelah status dan ssl.status keduanya active.",
      ],
      tokenAge,
      remedies,
    };
  }

  // Mode C: Domain sudah di Cloudflare (O2O) — PLAN §3.2
  const awaitingProviderTokens = !createBeforeCnameSatisfied;
  if (awaitingProviderTokens) {
    remedies.push({
      code: "AWAITING_PROVIDER_TOKENS",
      severity: "error",
      titleId: "Custom hostname wajib dibuat di Cloudflare sebelum CNAME O2O",
      messageId:
        "Untuk mencegah Error 1014 (CNAME Cross-User Banned), PunyaSitus harus menyelesaikan pendaftaran custom hostname di Cloudflare sebelum Anda menambahkan CNAME proxied.",
      actionHintId: 'Ulangi pendaftaran atau klik "Periksa sekarang" hingga custom hostname terdaftar.',
    });
  }

  const validationRecords: DomainValidationInstructionRecord[] = createBeforeCnameSatisfied
    ? [routingCnameRecord]
    : [];

  return {
    mode: "cloudflare_o2o",
    sslMethod: "http",
    hostname: input.hostname,
    cnameTarget,
    createBeforeCnameSatisfied,
    cnameCutoverLocked: !createBeforeCnameSatisfied,
    readyForCutover: createBeforeCnameSatisfied,
    awaitingProviderTokens,
    validationRecords,
    steps: [
      {
        stepNumber: 1,
        key: "create_custom_hostname_first",
        titleId: "Pendaftaran custom hostname di Cloudflare PunyaSitus",
        descriptionId: createBeforeCnameSatisfied
          ? "Custom hostname sudah terdaftar di Cloudflare (aman dari Error 1014)."
          : "Menunggu pendaftaran custom hostname selesai sebelum CNAME dapat ditambahkan.",
        locked: false,
        completed: createBeforeCnameSatisfied,
        records: [],
      },
      {
        stepNumber: 2,
        key: "add_o2o_proxied_cname",
        titleId: "Tambahkan CNAME proxied (awan oranye) & atur SSL/TLS Full/Full (strict)",
        descriptionId: createBeforeCnameSatisfied
          ? `Tambahkan CNAME proxied ${input.hostname} -> ${cnameTarget} di zona Cloudflare Anda, lalu pastikan mode SSL/TLS diatur ke Full atau Full (strict) (bukan Flexible).`
          : "Langkah ini terkunci hingga pendaftaran custom hostname pada langkah 1 selesai.",
        locked: !createBeforeCnameSatisfied,
        completed: createBeforeCnameSatisfied && cnameMatches && providerStatus === "active",
        records: createBeforeCnameSatisfied ? [routingCnameRecord] : [],
      },
    ],
    noticesId: [
      "Pre-validasi tidak didukung oleh Cloudflare untuk skenario O2O. Aktivasi akan langsung mengarahkan trafik dengan jeda singkat.",
      "Wajib atur mode SSL/TLS zona Cloudflare Anda ke Full atau Full (strict); mode Flexible akan menyebabkan redirect loop.",
    ],
    tokenAge,
    remedies,
  };
}

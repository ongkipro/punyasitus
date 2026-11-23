import { ALLOWED_EMAIL_SENDER } from "../email/templates.ts";

/**
 * Defense-in-depth Zero Visitor Personal Data Guard for Monthly Performance Reports
 * (`REQ-110`, `TASK-110`, `PLAN.md` §20.5).
 *
 * Invariant:
 * - Monthly report emails MUST NEVER contain visitor personal data:
 *   no visitor emails, IP addresses, phone numbers, User-Agent strings,
 *   visitor names, or raw lead messages.
 */

export class MonthlyReportPiiLeakError extends Error {
  readonly code = "E_REPORT_PII_DETECTED" as const;
  readonly retryable = false as const;
  readonly categories: readonly string[];

  constructor(categories: readonly string[]) {
    super(`E_REPORT_PII_DETECTED: monthly report contained forbidden PII categories (${categories.join(", ")})`);
    this.name = "MonthlyReportPiiLeakError";
    this.categories = categories;
  }
}

const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const IPV4_PATTERN = /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/g;
// Indonesian mobile/landline (+62 / 628 / 08) or international E.164 numbers (+9..15 digits)
const PHONE_PATTERN =
  /(?:^|[^\w/])(?:\+62[\s.-]?8\d(?:[\s.-]?\d){6,11}|(?<!\d)628\d{7,11}(?!\d)|(?<!\d)08\d(?:[\s.-]?\d){7,11}(?!\d)|\+[1-9]\d{8,14})(?=$|[^\w])/g;
const USER_AGENT_PATTERN = /\b(?:Mozilla\/5\.0|AppleWebKit\/\d|Chrome\/\d|Safari\/\d|Firefox\/\d|HeadlessChrome\/)\b/i;

function stripHtmlTagsForInspection(value: string): string {
  // Keep text content + attribute values that aren't standard boilerplate HTML tags
  return value.replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ");
}

/**
 * Sanitizes untrusted display strings (such as website names or offering titles)
 * before interpolation into monthly report metrics or tips.
 * Strips control characters, email addresses, IPv4 addresses, and phone numbers.
 */
export function sanitizeReportDisplayText(raw: string, maxLength = 120): string {
  let cleaned = raw
    .replace(/[\r\n\t\0]+/g, " ")
    .replace(EMAIL_PATTERN, "[redacted]")
    .replace(IPV4_PATTERN, "[redacted]")
    .replace(PHONE_PATTERN, " [redacted]")
    .replace(/\s+/g, " ")
    .trim();

  if (cleaned.length > maxLength) {
    cleaned = `${cleaned.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
  }
  return cleaned;
}

export interface VisitorPiiDetectionResult {
  readonly clean: boolean;
  readonly detectedCategories: readonly string[];
}

export interface AssertZeroVisitorPiiOptions {
  /** Platform sender addresses explicitly allowed in boilerplate footer (defaults to `noreply@notif.punyasitus.com`). */
  readonly allowedBoilerplateEmails?: readonly string[];
}

/**
 * Inspects rendered monthly report content (`subject`, `html`, `text`) for any
 * accidental visitor personal data (emails, IPv4 addresses, phone numbers, User-Agent strings).
 */
export function detectVisitorPiiInReportContent(
  rendered: {
    readonly subject: string;
    readonly html: string;
    readonly text: string;
  },
  options?: AssertZeroVisitorPiiOptions,
): VisitorPiiDetectionResult {
  const allowedEmails = new Set(
    (options?.allowedBoilerplateEmails ?? [ALLOWED_EMAIL_SENDER]).map((e) => e.trim().toLowerCase()),
  );

  const combinedText = [
    rendered.subject,
    rendered.text,
    stripHtmlTagsForInspection(rendered.html),
  ].join("\n");

  const categories = new Set<string>();

  const emailMatches = combinedText.match(EMAIL_PATTERN) ?? [];
  for (const match of emailMatches) {
    if (!allowedEmails.has(match.trim().toLowerCase())) {
      categories.add("email");
      break;
    }
  }

  if (IPV4_PATTERN.test(combinedText)) {
    categories.add("ipv4");
  }
  IPV4_PATTERN.lastIndex = 0;

  if (PHONE_PATTERN.test(combinedText)) {
    categories.add("phone");
  }
  PHONE_PATTERN.lastIndex = 0;

  if (USER_AGENT_PATTERN.test(combinedText)) {
    categories.add("user_agent");
  }

  const detectedCategories = Array.from(categories);
  return {
    clean: detectedCategories.length === 0,
    detectedCategories,
  };
}

/**
 * Asserts that rendered monthly performance report email content contains ZERO visitor PII.
 * Throws `MonthlyReportPiiLeakError` (non-retryable) if any forbidden pattern is detected.
 */
export function assertZeroVisitorPiiInMonthlyReport(
  rendered: {
    readonly subject: string;
    readonly html: string;
    readonly text: string;
  },
  options?: AssertZeroVisitorPiiOptions,
): void {
  const result = detectVisitorPiiInReportContent(rendered, options);
  if (!result.clean) {
    throw new MonthlyReportPiiLeakError(result.detectedCategories);
  }
}

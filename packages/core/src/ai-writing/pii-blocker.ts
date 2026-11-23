import type {
  AiWritingPiiCheckResult,
  AiWritingPiiFinding,
  AiWritingPiiKind,
  AiWritingSelectableFieldKey,
  AiWritingSelectedFields,
} from "./types.ts";

/**
 * Strictly linear O(n) pre-send PII blocker for AI Writing Suggestions
 * (REQ-075, PLAN §18.4, TASK-074).
 *
 * Security & privacy invariants:
 * - Runs deterministically in O(n) time without nested-quantifier regex backtracking (zero ReDoS).
 * - Blocks email addresses, Indonesian & international phone numbers (including WhatsApp links),
 *   and Indonesian NIK / NPWP identifiers BEFORE any AI provider call is issued.
 * - Avoids false positives on IDR currency amounts (`Rp 179.000`, `Rp 12.500.000`), years,
 *   measurements, and operating hours (`08.00 - 17.00`).
 * - NEVER returns matched raw PII strings in findings, errors, or logs.
 */

function isAsciiDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

function isAsciiLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isAsciiAlnum(code: number): boolean {
  return isAsciiDigit(code) || isAsciiLetter(code);
}

function isEmailLocalChar(code: number): boolean {
  return (
    isAsciiAlnum(code) ||
    code === 46 || // .
    code === 95 || // _
    code === 37 || // %
    code === 43 || // +
    code === 45 // -
  );
}

function isDomainLabelChar(code: number): boolean {
  return isAsciiAlnum(code) || code === 45; // -
}

function isPhoneSep(code: number): boolean {
  return (
    code === 32 || // space
    code === 45 || // -
    code === 46 || // .
    code === 40 || // (
    code === 41 || // )
    code === 47 // /
  );
}

/**
 * Linear O(n) email detector anchored on `@` positions.
 * Each `@` inspects at most 64 chars left and 253 chars right.
 */
export function countEmailMatchesLinear(text: string): number {
  const len = text.length;
  let count = 0;
  let i = 0;

  while (i < len) {
    const at = text.indexOf("@", i);
    if (at === -1) break;

    // Scan local part left (max 64 chars); stop at consecutive dots (`..` / ellipsis separator)
    let left = at - 1;
    const minLeft = Math.max(0, at - 64);
    while (left >= minLeft && isEmailLocalChar(text.charCodeAt(left))) {
      if (
        text.charCodeAt(left) === 46 &&
        left - 1 >= minLeft &&
        text.charCodeAt(left - 1) === 46
      ) {
        // Reached an ellipsis/double-dot boundary (e.g. "hubungi kami...info@toko.id")
        break;
      }
      left -= 1;
    }
    let localStart = left + 1;
    // Trim leading sentence punctuation dots/hyphens
    while (
      localStart < at &&
      (text.charCodeAt(localStart) === 46 || text.charCodeAt(localStart) === 45)
    ) {
      localStart += 1;
    }
    const localLen = at - localStart;

    // Scan domain part right (max 253 chars)
    let right = at + 1;
    const maxRight = Math.min(len, at + 1 + 253);
    while (right < maxRight) {
      const c = text.charCodeAt(right);
      if (isDomainLabelChar(c) || c === 46) {
        right += 1;
      } else {
        break;
      }
    }

    // Trim trailing dots from sentence punctuation (e.g. "info@toko.id.")
    let domainEnd = right;
    while (domainEnd > at + 1 && text.charCodeAt(domainEnd - 1) === 46) {
      domainEnd -= 1;
    }

    const domainLen = domainEnd - (at + 1);
    if (localLen >= 1 && domainLen >= 4) {
      const local = text.slice(localStart, at);
      const domain = text.slice(at + 1, domainEnd);
      if (
        !local.startsWith(".") &&
        !local.endsWith(".") &&
        !local.includes("..") &&
        !domain.startsWith(".") &&
        !domain.includes("..")
      ) {
        const labels = domain.split(".");
        if (labels.length >= 2) {
          const tld = labels[labels.length - 1] ?? "";
          let tldAllLetters = tld.length >= 2 && tld.length <= 24;
          for (let k = 0; tldAllLetters && k < tld.length; k += 1) {
            if (!isAsciiLetter(tld.charCodeAt(k))) {
              tldAllLetters = false;
            }
          }
          const labelsValid = labels.every(
            (lbl) => lbl.length >= 1 && !lbl.startsWith("-") && !lbl.endsWith("-"),
          );
          if (tldAllLetters && labelsValid) {
            count += 1;
            i = domainEnd;
            continue;
          }
        }
      }
    }

    i = at + 1;
  }

  return count;
}

function isPrecededByCurrencyPrefix(text: string, startIndex: number): boolean {
  let j = startIndex - 1;
  const minJ = Math.max(0, startIndex - 24);
  while (
    j >= minJ &&
    (text.charCodeAt(j) === 32 || text.charCodeAt(j) === 46 || isAsciiDigit(text.charCodeAt(j)))
  ) {
    j -= 1;
  }
  if (j < 0) return false;
  const tail2 = j >= 1 ? text.slice(j - 1, j + 1).toLowerCase() : "";
  const tail3 = j >= 2 ? text.slice(j - 2, j + 1).toLowerCase() : "";
  if (tail2 === "rp") {
    const before = j - 2;
    return before < 0 || !isAsciiLetter(text.charCodeAt(before));
  }
  if (tail3 === "idr" || tail3 === "usd") {
    const before = j - 3;
    return before < 0 || !isAsciiLetter(text.charCodeAt(before));
  }
  return false;
}

function looksLikeOperatingHoursRange(rawSpan: string): boolean {
  // e.g. "08.00-17.00", "08.00 - 17.00", "09.00-21.00"
  const compact = rawSpan.replace(/\s+/g, "");
  if (compact.length === 11 && compact[2] === "." && compact[5] === "-" && compact[8] === ".") {
    const h1 = Number(compact.slice(0, 2));
    const m1 = Number(compact.slice(3, 5));
    const h2 = Number(compact.slice(6, 8));
    const m2 = Number(compact.slice(9, 11));
    if (h1 >= 0 && h1 <= 24 && m1 >= 0 && m1 <= 59 && h2 >= 0 && h2 <= 24 && m2 >= 0 && m2 <= 59) {
      return true;
    }
  }
  return false;
}

function looksLikeIsoDate(rawSpan: string): boolean {
  // e.g. "2026-11-23" or "23-11-2026"
  if (rawSpan.length !== 10) return false;
  if (rawSpan[4] === "-" && rawSpan[7] === "-") {
    return (
      isAsciiDigit(rawSpan.charCodeAt(0)) &&
      isAsciiDigit(rawSpan.charCodeAt(1)) &&
      isAsciiDigit(rawSpan.charCodeAt(2)) &&
      isAsciiDigit(rawSpan.charCodeAt(3))
    );
  }
  if (rawSpan[2] === "-" && rawSpan[5] === "-") {
    const yr = Number(rawSpan.slice(6, 10));
    return yr >= 1900 && yr <= 2100;
  }
  return false;
}

function isNikProvinceCode(prefix: string): boolean {
  if (prefix.length !== 2) return false;
  const n = Number(prefix);
  return Number.isInteger(n) && n >= 11 && n <= 96;
}

function isValidNik16Digits(digits: string): boolean {
  if (digits.length !== 16) return false;
  if (!isNikProvinceCode(digits.slice(0, 2))) return false;
  const dayRaw = Number(digits.slice(6, 8));
  const monthRaw = Number(digits.slice(8, 10));
  const dayValid = (dayRaw >= 1 && dayRaw <= 31) || (dayRaw >= 41 && dayRaw <= 71);
  const monthValid = monthRaw >= 1 && monthRaw <= 12;
  return dayValid && monthValid;
}

function isFormattedNpwp(rawSpan: string, digits: string): boolean {
  // Traditional 15-digit NPWP: XX.XXX.XXX.X-XXX.XXX
  if (digits.length === 15 && rawSpan.includes(".") && rawSpan.includes("-")) {
    const compact = rawSpan.trim();
    if (
      compact.length === 20 &&
      compact[2] === "." &&
      compact[6] === "." &&
      compact[10] === "." &&
      compact[12] === "-" &&
      compact[16] === "."
    ) {
      return true;
    }
  }
  return false;
}

function hasIdLabelBefore(text: string, startIndex: number): boolean {
  const windowStart = Math.max(0, startIndex - 20);
  const prefix = text.slice(windowStart, startIndex).toLowerCase();
  return (
    prefix.includes("nik") ||
    prefix.includes("ktp") ||
    prefix.includes("npwp") ||
    prefix.includes("no. id") ||
    prefix.includes("no id")
  );
}

function hasNpwpLabelBefore(text: string, startIndex: number): boolean {
  const windowStart = Math.max(0, startIndex - 20);
  const prefix = text.slice(windowStart, startIndex).toLowerCase();
  return prefix.includes("npwp");
}

function hasShortAlphaLabelLeft(text: string, index: number): boolean {
  // Allows glued short alpha prefixes such as "WA0812...", "Tel0812...", "HP0812..."
  // while rejecting alphanumeric tokens/hex hashes like "a1b20812..." or "sku90812...".
  if (index === 0) return false;
  const prev = text.charCodeAt(index - 1);
  if (!isAsciiLetter(prev)) return false;

  let j = index - 1;
  let letters = 0;
  while (j >= 0 && isAsciiLetter(text.charCodeAt(j))) {
    letters += 1;
    if (letters > 8) return false;
    j -= 1;
  }
  if (j >= 0 && isAsciiDigit(text.charCodeAt(j))) {
    return false;
  }
  return letters >= 1;
}

function hasOnlyShortAlphaSuffixRight(text: string, endIndex: number): boolean {
  // Allows 1-2 trailing letters glued to an explicit mobile/international phone (e.g. "08123456789a")
  // while rejecting long hex hashes or alphanumeric SKUs.
  const len = text.length;
  if (endIndex >= len) return true;
  if (!isAsciiAlnum(text.charCodeAt(endIndex))) return true;
  if (isAsciiDigit(text.charCodeAt(endIndex))) return false;

  let j = endIndex;
  let letters = 0;
  while (j < len && isAsciiLetter(text.charCodeAt(j))) {
    letters += 1;
    if (letters > 2) return false;
    j += 1;
  }
  return j >= len || !isAsciiAlnum(text.charCodeAt(j));
}

/**
 * Linear O(n) single-pass scanner for phone numbers (Indonesian mobile/landline,
 * international +CC, WhatsApp links) and Indonesian NIK/NPWP numbers.
 */
export function scanPhoneAndIdMatchesLinear(text: string): {
  readonly phoneCount: number;
  readonly nikCount: number;
} {
  const len = text.length;
  let phoneCount = 0;
  let nikCount = 0;

  // Quick linear scan for WhatsApp links with embedded digits: wa.me/628... or phone=628...
  const lower = text.toLowerCase();
  let waPos = 0;
  while (waPos < len) {
    const idxWa = lower.indexOf("wa.me/", waPos);
    if (idxWa === -1) break;
    let p = idxWa + 6;
    if (p < len && text.charCodeAt(p) === 43) p += 1;
    let digits = 0;
    while (p < len && isAsciiDigit(text.charCodeAt(p)) && digits <= 16) {
      digits += 1;
      p += 1;
    }
    if (digits >= 8 && digits <= 15) {
      phoneCount += 1;
    }
    waPos = p;
  }

  let i = 0;
  while (i < len) {
    const c = text.charCodeAt(i);
    const isStart = c === 43 || c === 40 || isAsciiDigit(c); // '+', '(', or '0'-'9'
    if (!isStart) {
      i += 1;
      continue;
    }

    // Left boundary check: allow normal non-alphanumeric boundary, OR a short glued alpha label
    // (e.g. "WA08123456789", "Tel08123456789", "HP08123456789") strictly before +, 08, or 628.
    const gluedAlphaLeft = i > 0 && isAsciiAlnum(text.charCodeAt(i - 1));
    if (gluedAlphaLeft) {
      const startsGluedMobileOrPlus =
        c === 43 ||
        (c === 48 && i + 1 < len && text.charCodeAt(i + 1) === 56) || // "08"
        (c === 54 &&
          i + 2 < len &&
          text.charCodeAt(i + 1) === 50 &&
          text.charCodeAt(i + 2) === 56); // "628"
      if (!startsGluedMobileOrPlus || !hasShortAlphaLabelLeft(text, i)) {
        i += 1;
        continue;
      }
    }

    // Scan candidate span (max 28 chars, bounded linear step)
    const start = i;
    const maxEnd = Math.min(len, start + 28);
    let end = start;
    let digits = "";
    let lastWasSep = false;
    let sawDigit = false;
    let openParens = 0;

    while (end < maxEnd) {
      const ch = text.charCodeAt(end);
      if (
        ch === 43 &&
        (end === start || (end === start + 1 && text.charCodeAt(start) === 40 && openParens === 1))
      ) {
        end += 1;
        continue;
      }
      if (isAsciiDigit(ch)) {
        digits += text[end] ?? "";
        sawDigit = true;
        lastWasSep = false;
        end += 1;
        continue;
      }
      if (ch === 40 && openParens === 0) {
        // '(' allowed at start or immediately after '+' or space
        openParens += 1;
        lastWasSep = true;
        end += 1;
        continue;
      }
      if (ch === 41 && openParens === 1 && sawDigit) {
        openParens = 0;
        lastWasSep = false;
        end += 1;
        continue;
      }
      if (sawDigit && isPhoneSep(ch) && ch !== 40 && ch !== 41) {
        // Allow at most 2 adjacent separators (e.g. ") " or " - ")
        const nextIdx = end + 1;
        const nextIsDigitOrParenOrSpace =
          nextIdx < maxEnd &&
          (isAsciiDigit(text.charCodeAt(nextIdx)) ||
            text.charCodeAt(nextIdx) === 40 ||
            (text.charCodeAt(nextIdx) === 32 && !lastWasSep) ||
            (text.charCodeAt(nextIdx) === 45 && ch === 32));
        if (nextIsDigitOrParenOrSpace) {
          lastWasSep = true;
          end += 1;
          continue;
        }
      }
      break;
    }

    // Trim trailing separators
    while (end > start && !isAsciiDigit(text.charCodeAt(end - 1)) && text.charCodeAt(end - 1) !== 41) {
      end -= 1;
    }

    if (digits.length >= 8) {
      const rightIsAlnum = end < len && isAsciiAlnum(text.charCodeAt(end));
      const rawSpan = text.slice(start, end);

      // Check NIK / NPWP first (15-16 digits)
      if (!gluedAlphaLeft && !rightIsAlnum && !rawSpan.startsWith("+") && !isPrecededByCurrencyPrefix(text, start)) {
        if (
          (digits.length === 16 && (isValidNik16Digits(digits) || hasIdLabelBefore(text, start))) ||
          isFormattedNpwp(rawSpan, digits) ||
          (digits.length === 15 && hasNpwpLabelBefore(text, start))
        ) {
          nikCount += 1;
          i = Math.max(end, start + 1);
          continue;
        }
      }

      // Check phone number formats
      const startsPlus = rawSpan.startsWith("+") || rawSpan.startsWith("(+");
      const startsParenZero = rawSpan.startsWith("(0");
      const starts08 = digits.startsWith("08");
      const starts628 = digits.startsWith("628");
      const rightBoundaryOk =
        !rightIsAlnum || ((startsPlus || starts08 || starts628) && hasOnlyShortAlphaSuffixRight(text, end));

      if (
        rightBoundaryOk &&
        !isPrecededByCurrencyPrefix(text, start) &&
        !looksLikeOperatingHoursRange(rawSpan) &&
        !looksLikeIsoDate(rawSpan)
      ) {
        const starts00 = digits.startsWith("00") && digits.length >= 10 && digits.length <= 16;
        const startsIdAreaCode =
          digits.startsWith("0") &&
          digits.length >= 9 &&
          digits.length <= 13 &&
          "2345679".includes(digits[1] ?? "");

        const isInternationalPlus =
          startsPlus &&
          digits.length >= 8 &&
          digits.length <= 15 &&
          (digits[0] ?? "0") !== "0";

        const isIndonesianMobile =
          (starts08 && digits.length >= 9 && digits.length <= 13) ||
          (starts628 && digits.length >= 10 && digits.length <= 14);

        const isIndonesianLandline =
          !gluedAlphaLeft &&
          ((startsParenZero && digits.length >= 8 && digits.length <= 13) ||
            (startsIdAreaCode && (rawSpan.includes("-") || rawSpan.includes(" ") || rawSpan.includes("("))));

        // North American / international formatted phone e.g. (555) 123-4567 or 555-123-4567
        const isFormattedTenDigitPhone =
          !gluedAlphaLeft &&
          digits.length === 10 &&
          (rawSpan.startsWith("(") || (rawSpan.includes("-") && rawSpan.split("-").length === 3));

        if (
          isInternationalPlus ||
          (!gluedAlphaLeft && starts00) ||
          isIndonesianMobile ||
          isIndonesianLandline ||
          isFormattedTenDigitPhone
        ) {
          phoneCount += 1;
          i = Math.max(end, start + 1);
          continue;
        }
      }
    }

    // On non-match, advance ONLY past the first contiguous digit group (not `end`) so an adjacent
    // phone/NIK preceded by another number (e.g. "Hubungi 10 08123456789" or "Tahun 2018 0812-3456-7890")
    // is inspected on the next iteration. Total work remains strictly O(28 * n) = O(n).
    let nextIdx = start;
    if (nextIdx < end && (text.charCodeAt(nextIdx) === 43 || text.charCodeAt(nextIdx) === 40)) {
      nextIdx += 1;
    }
    while (nextIdx < end && isAsciiDigit(text.charCodeAt(nextIdx))) {
      nextIdx += 1;
    }
    i = Math.max(nextIdx, start + 1);
  }

  return { phoneCount, nikCount };
}

/**
 * Inspects a single plain-text string for PII in linear O(n) time.
 * Returns ONLY counts by PII category — never raw matched PII strings.
 */
export function scanTextForPii(text: string): Readonly<Record<AiWritingPiiKind, number>> {
  if (!text || text.length === 0) {
    return { email: 0, phone: 0, nik: 0 };
  }
  const email = countEmailMatchesLinear(text);
  const { phoneCount, nikCount } = scanPhoneAndIdMatchesLinear(text);
  return {
    email,
    phone: phoneCount,
    nik: nikCount,
  };
}

/**
 * Runs the pre-send PII blocker across ONLY the selected editorial fields.
 * Never exposes matched emails, phone numbers, or NIK values in its output.
 */
export function detectPiiInSelectedFields(
  selectedFields: AiWritingSelectedFields,
): AiWritingPiiCheckResult {
  const findings: AiWritingPiiFinding[] = [];
  const detectedKindSet = new Set<AiWritingPiiKind>();

  const checkField = (field: AiWritingSelectableFieldKey, value: string | undefined): void => {
    if (!value) return;
    const counts = scanTextForPii(value);
    for (const kind of ["email", "phone", "nik"] as const) {
      if (counts[kind] > 0) {
        findings.push({ field, kind, count: counts[kind] });
        detectedKindSet.add(kind);
      }
    }
  };

  checkField("currentText", selectedFields.currentText);
  checkField("title", selectedFields.title);
  checkField("summary", selectedFields.summary);
  checkField("category", selectedFields.category);

  if (selectedFields.keyPoints && selectedFields.keyPoints.length > 0) {
    const joined = selectedFields.keyPoints.join("\n");
    checkField("keyPoints", joined);
  }

  return {
    blocked: findings.length > 0,
    findings,
    detectedKinds: [...detectedKindSet],
  };
}

/**
 * Builds a clear, PII-free Bahasa Indonesia warning message for `422 AI_PII_DETECTED`.
 */
export function formatPiiBlockedMessageId(detectedKinds: readonly AiWritingPiiKind[]): string {
  const labels: string[] = [];
  if (detectedKinds.includes("email")) labels.push("alamat email");
  if (detectedKinds.includes("phone")) labels.push("nomor telepon / WhatsApp");
  if (detectedKinds.includes("nik")) labels.push("NIK / NPWP");
  const detail = labels.length > 0 ? labels.join(", ") : "data pribadi";
  return `Permintaan diblokir sebelum dikirim ke AI karena terdeteksi ${detail} pada teks yang dipilih. Hapus data pribadi tersebut terlebih dahulu agar privasi tetap terlindungi.`;
}

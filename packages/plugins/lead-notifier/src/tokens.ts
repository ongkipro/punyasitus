import {
  DEFAULT_TELEGRAM_BOT_USERNAME,
  TELEGRAM_LINK_TOKEN_TTL_MS,
  TELEGRAM_LINK_TOKEN_TTL_SECONDS,
  TELEGRAM_START_PARAM_MAX_LEN,
} from "./constants.ts";
import { generateRandomBase64Url, sha256Hex } from "./crypto.ts";

/**
 * 1-Click Telegram Bot Linking Token & Update Parser (`REQ-101`, `TASK-101`).
 *
 * Security invariants:
 * - Token format: `<tenantIdLen>_<tenantId>_<randomBase64Url>` strictly `<= 64` chars
 *   matching Telegram's `[A-Za-z0-9_-]{1,64}` `/start` payload specification.
 * - Minimum 16 random base64url chars (>= 96 bits entropy; 192+ bits for 26-char ULIDs).
 * - Only SHA-256 hex digest is persisted in `plg_lead_notifier__link_tokens`.
 * - Plaintext token is returned ONCE to the authenticated admin to build `https://t.me/<Bot>?start=<token>`
 *   and is NEVER persisted or logged.
 */

const SAFE_TENANT_ID_RE = /^[A-Za-z0-9_-]{1,36}$/;
const SAFE_BOT_USERNAME_RE = /^[A-Za-z0-9_]{5,32}$/;
const SAFE_TOKEN_RE = /^([1-9][0-9]?)_([A-Za-z0-9_-]+)$/;

export interface GeneratedTelegramLinkToken {
  readonly plaintextToken: string;
  readonly tokenHash: string;
  readonly tenantId: string;
  readonly botUsername: string;
  readonly deepLink: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly expiresInSeconds: number;
}

export interface ParsedTelegramLinkToken {
  readonly tenantId: string;
  readonly nonce: string;
  readonly rawToken: string;
}

export async function generateTelegramLinkToken(input: {
  readonly tenantId: string;
  readonly botUsername?: string;
  readonly nowMs?: number;
}): Promise<GeneratedTelegramLinkToken> {
  const tenantId = input.tenantId.trim();
  if (!SAFE_TENANT_ID_RE.test(tenantId)) {
    throw new Error("INVALID_TENANT_ID: Tenant ID is incompatible with Telegram deep-link token.");
  }

  const rawBot = (input.botUsername ?? DEFAULT_TELEGRAM_BOT_USERNAME).trim().replace(/^@/, "");
  const botUsername = SAFE_BOT_USERNAME_RE.test(rawBot) ? rawBot : DEFAULT_TELEGRAM_BOT_USERNAME;

  const prefix = `${tenantId.length}_${tenantId}_`;
  const remaining = TELEGRAM_START_PARAM_MAX_LEN - prefix.length;
  if (remaining < 16) {
    throw new Error("TENANT_ID_TOO_LONG: Insufficient entropy budget for Telegram deep-link token.");
  }

  const nonceLen = Math.min(32, remaining);
  const nonce = generateRandomBase64Url(Math.ceil((nonceLen * 3) / 4) + 2).slice(0, nonceLen);
  const plaintextToken = `${prefix}${nonce}`;
  const tokenHash = await sha256Hex(plaintextToken);

  const createdAt = Math.floor(input.nowMs ?? Date.now());
  const expiresAt = createdAt + TELEGRAM_LINK_TOKEN_TTL_MS;

  return {
    plaintextToken,
    tokenHash,
    tenantId,
    botUsername,
    deepLink: `https://t.me/${botUsername}?start=${plaintextToken}`,
    createdAt,
    expiresAt,
    expiresInSeconds: TELEGRAM_LINK_TOKEN_TTL_SECONDS,
  };
}

export function parseTelegramLinkToken(rawToken: string): ParsedTelegramLinkToken | null {
  if (typeof rawToken !== "string") return null;
  const trimmed = rawToken.trim();
  if (trimmed.length < 20 || trimmed.length > TELEGRAM_START_PARAM_MAX_LEN) {
    return null;
  }

  const match = SAFE_TOKEN_RE.exec(trimmed);
  if (!match) return null;

  const declaredLen = Number(match[1]);
  const rest = match[2] ?? "";
  if (!Number.isInteger(declaredLen) || declaredLen < 1 || declaredLen > 36) {
    return null;
  }

  // `rest` must be `<tenantId>_<nonce>` where `tenantId.length === declaredLen`
  if (rest.length < declaredLen + 1 + 16) {
    return null;
  }
  if (rest[declaredLen] !== "_") {
    return null;
  }

  const tenantId = rest.slice(0, declaredLen);
  const nonce = rest.slice(declaredLen + 1);
  if (!SAFE_TENANT_ID_RE.test(tenantId) || !/^[A-Za-z0-9_-]{16,44}$/.test(nonce)) {
    return null;
  }

  return {
    tenantId,
    nonce,
    rawToken: trimmed,
  };
}

export interface ParsedTelegramStartUpdate {
  readonly updateId: number | null;
  readonly token: string;
  readonly tenantId: string;
  readonly chatId: string;
  readonly chatType: string;
  readonly username: string | null;
  readonly displayName: string | null;
}

/**
 * Extracts `/start <token>` (or `/start@BotName <token>`) and chat metadata from a
 * Telegram Bot API Webhook Update JSON body.
 */
export function parseTelegramStartUpdate(rawBody: string): ParsedTelegramStartUpdate | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  const update = parsed as Record<string, unknown>;
  const message =
    update.message && typeof update.message === "object" && !Array.isArray(update.message)
      ? (update.message as Record<string, unknown>)
      : null;
  if (!message) return null;

  const text = typeof message.text === "string" ? message.text.trim() : "";
  const startMatch = /^\/start(?:@[A-Za-z0-9_]+)?\s+([A-Za-z0-9_-]{16,64})(?:\s.*)?$/i.exec(text);
  if (!startMatch || !startMatch[1]) {
    return null;
  }

  const parsedToken = parseTelegramLinkToken(startMatch[1]);
  if (!parsedToken) {
    return null;
  }

  const chat =
    message.chat && typeof message.chat === "object" && !Array.isArray(message.chat)
      ? (message.chat as Record<string, unknown>)
      : null;
  if (!chat) return null;

  const rawChatId = chat.id;
  let chatId = "";
  if (typeof rawChatId === "number" && Number.isSafeInteger(rawChatId)) {
    chatId = String(rawChatId);
  } else if (typeof rawChatId === "string" && /^-?\d{1,24}$/.test(rawChatId.trim())) {
    chatId = rawChatId.trim();
  }
  if (!chatId) return null;

  const chatType =
    typeof chat.type === "string" && chat.type.trim().length > 0
      ? chat.type.trim().toLowerCase().slice(0, 32)
      : "private";

  const from =
    message.from && typeof message.from === "object" && !Array.isArray(message.from)
      ? (message.from as Record<string, unknown>)
      : null;

  const rawUsername =
    typeof chat.username === "string" && chat.username.trim().length > 0
      ? chat.username.trim()
      : typeof from?.username === "string" && from.username.trim().length > 0
        ? from.username.trim()
        : null;

  const firstName =
    typeof chat.first_name === "string" && chat.first_name.trim().length > 0
      ? chat.first_name.trim()
      : typeof from?.first_name === "string" && from.first_name.trim().length > 0
        ? from.first_name.trim()
        : "";
  const lastName =
    typeof chat.last_name === "string" && chat.last_name.trim().length > 0
      ? chat.last_name.trim()
      : typeof from?.last_name === "string" && from.last_name.trim().length > 0
        ? from.last_name.trim()
        : "";
  const chatTitle = typeof chat.title === "string" ? chat.title.trim() : "";

  const displayName =
    chatTitle || [firstName, lastName].filter(Boolean).join(" ").trim() || null;

  const updateId =
    typeof update.update_id === "number" && Number.isSafeInteger(update.update_id)
      ? update.update_id
      : null;

  return {
    updateId,
    token: parsedToken.rawToken,
    tenantId: parsedToken.tenantId,
    chatId,
    chatType,
    username: rawUsername ? rawUsername.slice(0, 64) : null,
    displayName: displayName ? displayName.slice(0, 100) : null,
  };
}

function maskSegment(segment: string): string {
  const clean = segment.trim();
  if (clean.length <= 1) return "*";
  if (clean.length <= 3) return `${clean[0]}***`;
  if (clean.length <= 6) return `${clean.slice(0, 2)}***${clean.slice(-1)}`;
  return `${clean.slice(0, 2)}***${clean.slice(-2)}`;
}

/**
 * Masks Telegram username / display name / chat ID so admin UI & delivery logs
 * never expose raw chat IDs or full personal handles.
 */
export function maskTelegramChatLabel(input: {
  readonly username?: string | null;
  readonly displayName?: string | null;
  readonly chatId: string;
}): string {
  const cleanUsername = input.username?.trim().replace(/^@/, "") ?? "";
  if (cleanUsername.length > 0) {
    return `@${maskSegment(cleanUsername)}`;
  }

  const cleanName = input.displayName?.trim() ?? "";
  if (cleanName.length > 0) {
    const parts = cleanName.split(/\s+/).slice(0, 3);
    return parts.map((p) => maskSegment(p)).join(" ");
  }

  const digits = input.chatId.replace(/[^0-9]/g, "");
  const tail = digits.length >= 4 ? digits.slice(-4) : digits || "0000";
  return `Telegram #***${tail}`;
}

/**
 * Produces a secret-free summary of a webhook target URL (origin host only, zero query/creds).
 */
export function sanitizeWebhookTargetSummary(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    return `https://${parsed.hostname.toLowerCase()}`;
  } catch {
    return "webhook-target";
  }
}

/**
 * Deterministic Event ID & Bounded 24-Hour Per-Event Deduplication Engine
 * (`packages/core/src/analytics/dedup.ts`; TASK-065, REQ-027, REQ-017, REQ-039, PLAN §5, §7.3, §18.1).
 *
 * Security & correctness invariants:
 * 1. ONE EVENT ID PER LOGICAL ACTION: generates standard lowercase RFC 4122 UUIDs so the
 *    exact same `event_id` flows through first-party `POST /api/events`, direct GA4 / Meta / TikTok,
 *    and GTM `ps_*` `dataLayer` events without double-counting.
 * 2. STRICT PII-FREE VALIDATION: rejects emails, phone numbers, query strings, URLs, whitespace,
 *    control characters, and HTML/script payloads inside `event_id`.
 * 3. TENANT-SCOPED 24-HOUR TTL WITH BOUNDED CARDINALITY: deduplicates by `(tenantScope, key)`
 *    with a 24-hour expiry and strict `maxEntries` cap so browser storage can never grow unbounded.
 * 4. FAULT ISOLATION: storage failures (private browsing / QuotaExceededError) degrade gracefully
 *    to in-memory dedup without ever breaking CTAs or forms.
 */

export const ANALYTICS_EVENT_DEDUP_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_ANALYTICS_EVENT_ID_LENGTH = 64;
export const DEFAULT_CLIENT_DEDUP_MAX_ENTRIES = 256;
export const DEFAULT_CTA_DOUBLE_CLICK_WINDOW_MS = 1_500;
export const CLIENT_DEDUP_STORAGE_PREFIX = "ps_evt_dedup_v1:";

export const ANALYTICS_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const SAFE_CLIENT_EVENT_TOKEN_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const SAFE_TENANT_SCOPE_RE = /^[a-z0-9][a-z0-9._:-]{0,127}$/;
const EMAIL_IN_ID_RE = /@/;
const QUERY_OR_SCHEME_IN_ID_RE = /[?&#=/:\\\s<>"';(){}]/;
const PHONE_IN_TOKEN_RE = /(?:^|[^0-9])(?:\+?62|0)8[0-9]{7,12}(?:$|[^0-9])|[0-9]{10,}/;

export interface ClientDedupStorageLike {
  readonly getItem: (key: string) => string | null;
  readonly setItem: (key: string, value: string) => void;
  readonly removeItem?: (key: string) => void;
}

export interface ClientEventDedupStoreOptions {
  readonly tenantScope?: string | null;
  readonly ttlMs?: number;
  readonly maxEntries?: number;
  readonly storage?: ClientDedupStorageLike | null;
  /**
   * Optional consent gate for client storage persistence (`REQ-039`).
   * When returning `false`, all dedup stays strictly in-memory with ZERO reads/writes
   * to `localStorage` or `sessionStorage`. Defaults to `() => true`.
   */
  readonly canPersistStorage?: () => boolean;
}

export interface ClientEventDedupStore {
  readonly tenantScope: string;
  readonly ttlMs: number;
  readonly maxEntries: number;
  readonly has: (key: string, nowMs?: number) => boolean;
  readonly claim: (key: string, nowMs?: number) => boolean;
  readonly prune: (nowMs?: number) => number;
  readonly size: (nowMs?: number) => number;
  readonly clear: () => void;
  /** Removes the tenant-scoped persisted storage key without clearing in-memory state. */
  readonly clearPersistedStorage: () => void;
}

function stripControlChars(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 0x20 && code !== 0x7f) {
      out += value[i];
    }
  }
  return out;
}

/**
 * Checks whether a value is a strict RFC 4122 UUID (versions 1-8, RFC 4122 variant).
 */
export function isValidAnalyticsUuid(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length !== 36) return false;
  return ANALYTICS_UUID_RE.test(value);
}

function formatBytesAsUuid(bytes: Uint8Array): string {
  const hex: string[] = [];
  for (let i = 0; i < 16; i += 1) {
    hex.push((bytes[i] ?? 0).toString(16).padStart(2, "0"));
  }
  return [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10, 16).join(""),
  ].join("-");
}

/**
 * Generates a fresh lowercase RFC 4122 UUID v4 suitable for parity across
 * first-party `POST /api/events`, GA4, Meta Pixel (`eventID`), TikTok (`event_id`),
 * and GTM `ps_*` `dataLayer` events.
 */
export function generateAnalyticsEventId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID().toLowerCase();
    }
    if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
      bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
      return formatBytesAsUuid(bytes);
    }
  } catch {
    // Fallback below
  }
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) {
    bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  return formatBytesAsUuid(bytes);
}

function fnv1a32(input: string, seed: number): number {
  let hash = seed >>> 0;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function deriveDeterministicUuidV5FromSeed(seed: string): string {
  const h0 = fnv1a32(`${seed}#0`, 0x811c9dc5);
  const h1 = fnv1a32(`${seed}#1`, 0x9e3779b9);
  const h2 = fnv1a32(`${seed}#2`, 0x85ebca6b);
  const h3 = fnv1a32(`${seed}#3`, 0xc2b2ae35);

  const bytes = new Uint8Array(16);
  const parts = [h0, h1, h2, h3];
  for (let i = 0; i < 4; i += 1) {
    const val = parts[i] ?? 0;
    bytes[i * 4] = (val >>> 24) & 0xff;
    bytes[i * 4 + 1] = (val >>> 16) & 0xff;
    bytes[i * 4 + 2] = (val >>> 8) & 0xff;
    bytes[i * 4 + 3] = val & 0xff;
  }
  // Set RFC 4122 version 5 and variant 10xx
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  return formatBytesAsUuid(bytes);
}

/**
 * Derives a deterministic, RFC 4122 v5-formatted UUID from a persisted `leadId`
 * (optionally scoped by `tenantScope`). Always produces the exact same valid UUID
 * across retries, PRG banners, live DOM observers, and page reloads so direct tags
 * and GTM `ps_lead_submitted` stay 100% aligned and deduplicated.
 */
export function deriveDeterministicLeadEventId(
  leadId: string,
  tenantScope = "default",
): string {
  const scope = normalizeTenantDedupScope(tenantScope);
  return deriveDeterministicUuidV5FromSeed(`punyasitus:v1:lead:${scope}:${leadId.trim()}`);
}

/**
 * Normalizes any sanitized `event_id` (UUID or non-UUID opaque token like `"abc_1"`) into
 * a valid lowercase RFC 4122 UUID so first-party `POST /api/events`, GTM `dataLayer`, and
 * direct GA4 / Meta / TikTok channels ALWAYS receive the exact same UUID without divergence.
 */
export function normalizeAnalyticsEventIdToUuid(
  sanitizedEventId: string,
  tenantScope = "default",
): string {
  const trimmed = sanitizedEventId.trim();
  if (ANALYTICS_UUID_RE.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  const scope = normalizeTenantDedupScope(tenantScope);
  return deriveDeterministicUuidV5FromSeed(`punyasitus:v1:token:${scope}:${trimmed}`);
}

/**
 * Sanitizes a client-supplied `event_id` for direct/GTM signal dispatch:
 * - Accepts strict RFC 4122 UUIDs (normalized lowercase) OR bounded safe opaque tokens
 *   (`^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$` with zero embedded phone numbers).
 * - Strictly rejects query strings, emails, phone numbers, whitespace, control characters,
 *   URLs, and HTML/script payloads.
 */
export function sanitizeClientEventId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = stripControlChars(raw).trim();
  if (cleaned.length === 0 || cleaned.length > MAX_ANALYTICS_EVENT_ID_LENGTH) {
    return null;
  }
  if (EMAIL_IN_ID_RE.test(cleaned) || QUERY_OR_SCHEME_IN_ID_RE.test(cleaned)) {
    return null;
  }
  if (ANALYTICS_UUID_RE.test(cleaned)) {
    return cleaned.toLowerCase();
  }
  if (!SAFE_CLIENT_EVENT_TOKEN_RE.test(cleaned)) {
    return null;
  }
  if (PHONE_IN_TOKEN_RE.test(cleaned)) {
    return null;
  }
  return cleaned;
}

/**
 * Normalizes a tenant scope identifier (e.g. verified host or tenant handle) into a safe
 * bounded storage namespace key. Never leaks query strings or PII.
 */
export function normalizeTenantDedupScope(raw: unknown): string {
  if (typeof raw !== "string") return "default";
  const cleaned = stripControlChars(raw).trim().toLowerCase().split(/[?#/]/, 1)[0] ?? "";
  if (!cleaned || !SAFE_TENANT_SCOPE_RE.test(cleaned) || EMAIL_IN_ID_RE.test(cleaned)) {
    return "default";
  }
  return cleaned;
}

/**
 * Creates a tenant-scoped, bounded-cardinality, 24-hour TTL client-side dedup store.
 * Optionally synchronizes to `localStorage`/`sessionStorage` (fully fault-isolated) so
 * duplicate events across retries, double-clicks, or reloads within 24h never double-fire.
 */
export function createClientEventDedupStore(
  options: ClientEventDedupStoreOptions = {},
): ClientEventDedupStore {
  const tenantScope = normalizeTenantDedupScope(options.tenantScope);
  const ttlMs =
    typeof options.ttlMs === "number" && Number.isFinite(options.ttlMs) && options.ttlMs >= 1_000
      ? Math.floor(options.ttlMs)
      : ANALYTICS_EVENT_DEDUP_TTL_MS;
  const maxEntries =
    typeof options.maxEntries === "number" &&
    Number.isFinite(options.maxEntries) &&
    options.maxEntries >= 1
      ? Math.min(2_048, Math.floor(options.maxEntries))
      : DEFAULT_CLIENT_DEDUP_MAX_ENTRIES;
  const storage = options.storage ?? null;
  const canPersistStorage = options.canPersistStorage ?? (() => true);
  const storageKey = `${CLIENT_DEDUP_STORAGE_PREFIX}${tenantScope}`;

  const entries = new Map<string, number>();

  function isStoragePersistenceAllowed(): boolean {
    if (!storage) return false;
    try {
      return canPersistStorage() === true;
    } catch {
      return false;
    }
  }

  function loadFromStorage(nowMs: number): void {
    if (!isStoragePersistenceAllowed() || !storage) return;
    try {
      const raw = storage.getItem(storageKey);
      if (!raw) return;
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === "number" && Number.isFinite(v) && v > nowMs) {
          const existing = entries.get(k);
          if (existing === undefined || v > existing) {
            entries.set(k, v);
          }
        }
      }
    } catch {
      // Malformed or blocked storage falls back safely to in-memory map
    }
  }

  function pruneInternal(nowMs: number): number {
    let removed = 0;
    for (const [k, exp] of entries.entries()) {
      if (exp <= nowMs) {
        entries.delete(k);
        removed += 1;
      }
    }
    if (entries.size > maxEntries) {
      const sorted = Array.from(entries.entries()).sort((a, b) => a[1] - b[1]);
      const overflow = entries.size - maxEntries;
      for (let i = 0; i < overflow; i += 1) {
        const keyToDrop = sorted[i]?.[0];
        if (keyToDrop !== undefined) {
          entries.delete(keyToDrop);
          removed += 1;
        }
      }
    }
    return removed;
  }

  function persistToStorage(): void {
    if (!isStoragePersistenceAllowed() || !storage) return;
    try {
      if (entries.size === 0) {
        storage.removeItem?.(storageKey);
        return;
      }
      const obj: Record<string, number> = {};
      for (const [k, exp] of entries.entries()) {
        obj[k] = exp;
      }
      storage.setItem(storageKey, JSON.stringify(obj));
    } catch {
      // Ignore QuotaExceededError / private browsing failures
    }
  }

  function clearPersistedStorageInternal(): void {
    if (!storage) return;
    try {
      storage.removeItem?.(storageKey);
    } catch {
      // Non-blocking
    }
  }

  loadFromStorage(Date.now());
  pruneInternal(Date.now());

  return {
    tenantScope,
    ttlMs,
    maxEntries,

    has(key: string, nowMs: number = Date.now()): boolean {
      const safeNow = Math.floor(nowMs);
      loadFromStorage(safeNow);
      const exp = entries.get(key);
      if (exp === undefined) return false;
      if (exp <= safeNow) {
        entries.delete(key);
        persistToStorage();
        return false;
      }
      return true;
    },

    claim(key: string, nowMs: number = Date.now()): boolean {
      const safeNow = Math.floor(nowMs);
      loadFromStorage(safeNow);
      const existing = entries.get(key);
      if (existing !== undefined && existing > safeNow) {
        return false;
      }
      entries.set(key, safeNow + ttlMs);
      pruneInternal(safeNow);
      persistToStorage();
      return true;
    },

    prune(nowMs: number = Date.now()): number {
      const safeNow = Math.floor(nowMs);
      loadFromStorage(safeNow);
      const removed = pruneInternal(safeNow);
      persistToStorage();
      return removed;
    },

    size(nowMs: number = Date.now()): number {
      const safeNow = Math.floor(nowMs);
      loadFromStorage(safeNow);
      pruneInternal(safeNow);
      return entries.size;
    },

    clear(): void {
      entries.clear();
      clearPersistedStorageInternal();
    },

    clearPersistedStorage(): void {
      clearPersistedStorageInternal();
    },
  };
}

export interface CtaClickActionGuard {
  /**
   * Resolves a single `eventId` for a logical CTA interaction:
   * - If an explicit valid `explicitEventId` is provided, honors it.
   * - If the same CTA `actionKey` is clicked again within `windowMs` (rapid double-click),
   *   reuses the SAME `eventId` so downstream client & server dedup suppress the duplicate.
   * - Otherwise allocates a fresh UUID v4.
   */
  readonly resolveEventId: (
    actionKey: string,
    options?: { readonly explicitEventId?: string | null; readonly nowMs?: number },
  ) => string;
}

export function createCtaClickActionGuard(
  windowMs: number = DEFAULT_CTA_DOUBLE_CLICK_WINDOW_MS,
  generateId: () => string = generateAnalyticsEventId,
): CtaClickActionGuard {
  const safeWindowMs = Number.isFinite(windowMs) && windowMs >= 0 ? Math.floor(windowMs) : 1_500;
  const recent = new Map<string, { readonly eventId: string; readonly at: number }>();

  return {
    resolveEventId(actionKey, options) {
      const explicit = sanitizeClientEventId(options?.explicitEventId);
      if (explicit) return explicit;

      const nowMs = Math.floor(options?.nowMs ?? Date.now());
      const prev = recent.get(actionKey);
      if (prev && nowMs - prev.at >= 0 && nowMs - prev.at < safeWindowMs) {
        return prev.eventId;
      }

      // Bounded cache pruning
      if (recent.size >= 64) {
        for (const [k, v] of recent.entries()) {
          if (nowMs - v.at >= safeWindowMs) {
            recent.delete(k);
          }
        }
        if (recent.size >= 64) {
          recent.clear();
        }
      }

      const fresh = generateId();
      recent.set(actionKey, { eventId: fresh, at: nowMs });
      return fresh;
    },
  };
}

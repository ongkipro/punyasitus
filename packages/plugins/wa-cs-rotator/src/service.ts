import type { PluginTenantDb, PluginTenantSnapshot } from "@punyasitus/core/plugins/index";
import {
  buildWhatsAppUrl,
  normalizeIndonesianWhatsAppNumber,
  validateIndonesianWhatsAppNumber,
} from "@punyasitus/core/wa-dispatcher";
import {
  computeAttributionShares,
  isAgentOnShift,
  selectNextWaAgent,
  type AgentAttributionShare,
  type WaRotatorAgentLike,
  type WaRotatorCursorState,
} from "./rotator.ts";
import {
  DEFAULT_WA_CS_ROTATOR_CONFIG,
  formatDayBucketInTimezone,
  isValidAgentId,
  isValidTimeZone,
  normalizeScheduleDays,
  sanitizeSourcePath,
  sanitizeWaItemTitle,
  serializeScheduleDays,
  validateWaAgentInput,
  WA_CS_DEFAULT_TIMEZONE,
  WA_CS_MAX_AGENTS,
  WaCsRotatorValidationError,
  type WaAgentInput,
  type WaRotationStrategy,
} from "./validation.ts";

/**
 * Tenant-isolated database service & WhatsApp CTA rotator dispatcher (`REQ-099`, `TASK-099`).
 *
 * Security, concurrency & privacy invariants:
 * - Every plugin query strictly targets `plg_wa_cs_rotator__*` inside `PluginTenantDb`.
 * - Optimistic Compare-And-Set (`state_version`) with bounded retry prevents duplicate
 *   agent assignments or lost cursor increments under concurrent traffic.
 * - Zero visitor PII recorded (`source_path` strips query/fragments; no IP/UA/cookies).
 * - Bounded click retention: compact daily aggregates in `plg_wa_cs_rotator__clicks_daily`
 *   plus automatic 90-day pruning of raw rows in `plg_wa_cs_rotator__clicks`.
 * - HEAD & browser prefetch/prerender requests never mutate cursor or click counters.
 * - Instant revert to single-number base WhatsApp (`REQ-014`) with zero plugin DB queries
 *   whenever the plugin is disabled or unentitled.
 */

export const WA_ROTATOR_CAS_MAX_RETRIES = 5 as const;
export const WA_CLICKS_RETENTION_DAYS = 90 as const;
export const WA_CLICKS_RETENTION_MS = WA_CLICKS_RETENTION_DAYS * 86_400_000;
const FALLBACK_AGENT_KEY = "__fallback__" as const;

export interface WaAgentRecord extends WaRotatorAgentLike {
  readonly totalClicks: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface WaRotatorStateRecord extends WaRotatorCursorState {
  readonly fallbackWhatsappPhone: string;
  readonly timezone: string;
  readonly fallbackClicks: number;
  readonly lastAgentId: string | null;
  readonly stateVersion: number;
  readonly updatedAt: number | null;
}

export interface WaClickDailyBucket {
  readonly agentId: string | null;
  readonly dayBucket: string;
  readonly clicks: number;
}

export interface WaAttributionStats {
  readonly strategy: WaRotationStrategy;
  readonly totalClicks: number;
  readonly agentClicks: number;
  readonly fallbackClicks: number;
  readonly fallbackSharePercent: number;
  readonly activeAgentCount: number;
  readonly onShiftAgentCount: number;
  readonly agents: readonly AgentAttributionShare[];
  readonly dailyClicks: readonly WaClickDailyBucket[];
}

interface RawAgentRow {
  readonly id: string;
  readonly name: string;
  readonly role_label: string;
  readonly phone_e164: string;
  readonly weight: number;
  readonly schedule_days: string;
  readonly start_time: string;
  readonly end_time: string;
  readonly timezone: string;
  readonly is_active: number;
  readonly sort_order: number;
  readonly total_clicks: number;
  readonly created_at: number;
  readonly updated_at: number;
}

interface RawStateRow {
  readonly strategy: string;
  readonly cursor_index: number;
  readonly weighted_state_json: string;
  readonly fallback_whatsapp_phone: string;
  readonly timezone: string;
  readonly fallback_clicks: number;
  readonly last_agent_id: string | null;
  readonly state_version: number;
  readonly updated_at: number;
}

function mapAgentRow(row: RawAgentRow): WaAgentRecord {
  return {
    id: row.id,
    name: row.name,
    roleLabel: row.role_label || "Sales CS",
    phoneE164: row.phone_e164,
    weight: Number(row.weight ?? 1),
    scheduleDays: normalizeScheduleDays(row.schedule_days),
    startTime: row.start_time || "08:00",
    endTime: row.end_time || "17:00",
    timezone: row.timezone || WA_CS_DEFAULT_TIMEZONE,
    isActive: Number(row.is_active) === 1,
    sortOrder: Number(row.sort_order ?? 0),
    totalClicks: Number(row.total_clicks ?? 0),
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
  };
}

function parseWeightedStateJson(raw: string | null | undefined): Record<string, number> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const clean: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v)) {
        clean[k] = v;
      }
    }
    return clean;
  } catch {
    return {};
  }
}

function generateId(prefix: string, nowMs: number): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${prefix}_${nowMs.toString(36)}_${hex}`;
}

function resolveStrategyFromConfig(
  config?: Readonly<Record<string, unknown>>,
): WaRotationStrategy {
  return config?.strategy === "weighted" ? "weighted" : "round_robin";
}

function resolveFallbackFromConfig(config?: Readonly<Record<string, unknown>>): string {
  if (typeof config?.fallbackWhatsappPhone !== "string") return "";
  const checked = validateIndonesianWhatsAppNumber(config.fallbackWhatsappPhone);
  return checked.ok ? checked.phone : "";
}

function resolveTimezoneFromConfig(config?: Readonly<Record<string, unknown>>): string {
  if (typeof config?.timezone === "string" && isValidTimeZone(config.timezone.trim())) {
    return config.timezone.trim();
  }
  return WA_CS_DEFAULT_TIMEZONE;
}

/**
 * Returns true when an incoming request is a HEAD probe or browser prefetch/prerender
 * that must NOT advance the rotator cursor or increment click counters.
 */
export function isNonCountingWaRequest(request: Request): boolean {
  if (request.method.toUpperCase() === "HEAD") return true;
  const purpose = (request.headers.get("purpose") ?? "").toLowerCase();
  const secPurpose = (request.headers.get("sec-purpose") ?? "").toLowerCase();
  const xPurpose = (request.headers.get("x-purpose") ?? "").toLowerCase();
  const xMoz = (request.headers.get("x-moz") ?? "").toLowerCase();
  return (
    purpose.includes("prefetch") ||
    purpose.includes("prerender") ||
    secPurpose.includes("prefetch") ||
    secPurpose.includes("prerender") ||
    xPurpose.includes("prefetch") ||
    xPurpose.includes("preview") ||
    xMoz === "prefetch"
  );
}

/**
 * Reads the tenant's base REQ-014 primary WhatsApp number from `TenantStore.business_profile`
 * when an unrestricted base `D1Database` handle is available to the host caller.
 * Never throws on missing tables or invalid values.
 */
export async function readTenantPrimaryWhatsappFromStore(
  tenantDb: D1Database | null | undefined,
): Promise<string | null> {
  if (!tenantDb) return null;
  try {
    const row = await tenantDb
      .prepare(
        "SELECT whatsapp_e164, published_json, draft_json FROM business_profile WHERE id = 1 LIMIT 1",
      )
      .first<{
        readonly whatsapp_e164?: string | null;
        readonly published_json?: string | null;
        readonly draft_json?: string | null;
      }>();

    const candidates: string[] = [];
    if (typeof row?.whatsapp_e164 === "string" && row.whatsapp_e164.trim().length > 0) {
      candidates.push(row.whatsapp_e164);
    }
    for (const jsonCol of [row?.published_json, row?.draft_json]) {
      if (typeof jsonCol !== "string" || jsonCol.trim().length === 0) continue;
      try {
        const parsed = JSON.parse(jsonCol) as {
          readonly whatsappE164?: unknown;
          readonly whatsapp_e164?: unknown;
          readonly whatsapp?: unknown;
        };
        if (typeof parsed.whatsappE164 === "string") candidates.push(parsed.whatsappE164);
        if (typeof parsed.whatsapp_e164 === "string") candidates.push(parsed.whatsapp_e164);
        if (typeof parsed.whatsapp === "string") candidates.push(parsed.whatsapp);
      } catch {
        // Ignore malformed JSON
      }
    }

    for (const raw of candidates) {
      const checked = validateIndonesianWhatsAppNumber(raw);
      if (checked.ok) return checked.phone;
    }
    return null;
  } catch {
    return null;
  }
}

export async function listWaAgents(db: PluginTenantDb): Promise<WaAgentRecord[]> {
  const res = await db
    .prepare(
      `SELECT id, name, role_label, phone_e164, weight, schedule_days, start_time, end_time,
              timezone, is_active, sort_order, total_clicks, created_at, updated_at
       FROM plg_wa_cs_rotator__agents
       ORDER BY sort_order ASC, created_at ASC, id ASC`,
    )
    .all<RawAgentRow>();
  return (res.results ?? []).map(mapAgentRow);
}

export async function getWaAgentById(
  db: PluginTenantDb,
  agentId: string,
): Promise<WaAgentRecord | null> {
  if (!isValidAgentId(agentId)) return null;
  const row = await db
    .prepare(
      `SELECT id, name, role_label, phone_e164, weight, schedule_days, start_time, end_time,
              timezone, is_active, sort_order, total_clicks, created_at, updated_at
       FROM plg_wa_cs_rotator__agents
       WHERE id = ?
       LIMIT 1`,
    )
    .bind(agentId.trim().toLowerCase())
    .first<RawAgentRow>();
  return row ? mapAgentRow(row) : null;
}

export async function createWaAgent(
  db: PluginTenantDb,
  input: WaAgentInput,
  nowMs: number,
): Promise<WaAgentRecord> {
  const validated = validateWaAgentInput(input);
  const countRow = await db
    .prepare("SELECT COUNT(*) AS total FROM plg_wa_cs_rotator__agents")
    .first<{ readonly total: number }>();
  const currentTotal = Number(countRow?.total ?? 0);
  if (currentTotal >= WA_CS_MAX_AGENTS) {
    throw new WaCsRotatorValidationError(
      "VALIDATION_ERROR",
      `Maksimal ${WA_CS_MAX_AGENTS} agen CS WhatsApp per situs.`,
    );
  }

  const sortOrder =
    typeof input.sortOrder === "number" ? validated.sortOrder : currentTotal;
  const id = generateId("agt", nowMs);

  await db
    .prepare(
      `INSERT INTO plg_wa_cs_rotator__agents (
         id, name, role_label, phone_e164, weight, schedule_days, start_time, end_time,
         timezone, is_active, sort_order, total_clicks, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    )
    .bind(
      id,
      validated.name,
      validated.roleLabel,
      validated.phoneE164,
      validated.weight,
      serializeScheduleDays(validated.scheduleDays),
      validated.startTime,
      validated.endTime,
      validated.timezone,
      validated.isActive ? 1 : 0,
      sortOrder,
      nowMs,
      nowMs,
    )
    .run();

  return {
    id,
    name: validated.name,
    roleLabel: validated.roleLabel,
    phoneE164: validated.phoneE164,
    weight: validated.weight,
    scheduleDays: validated.scheduleDays,
    startTime: validated.startTime,
    endTime: validated.endTime,
    timezone: validated.timezone,
    isActive: validated.isActive,
    sortOrder,
    totalClicks: 0,
    createdAt: nowMs,
    updatedAt: nowMs,
  };
}

export async function updateWaAgent(
  db: PluginTenantDb,
  agentId: string,
  patch: Partial<WaAgentInput>,
  nowMs: number,
): Promise<WaAgentRecord | null> {
  const existing = await getWaAgentById(db, agentId);
  if (!existing) return null;

  const merged = validateWaAgentInput({
    name: patch.name !== undefined ? patch.name : existing.name,
    roleLabel: patch.roleLabel !== undefined ? patch.roleLabel : existing.roleLabel,
    phone:
      patch.phone !== undefined
        ? patch.phone
        : patch.phoneE164 !== undefined
          ? patch.phoneE164
          : existing.phoneE164,
    weight: patch.weight !== undefined ? patch.weight : existing.weight,
    scheduleDays: patch.scheduleDays !== undefined ? patch.scheduleDays : existing.scheduleDays,
    startTime: patch.startTime !== undefined ? patch.startTime : existing.startTime,
    endTime: patch.endTime !== undefined ? patch.endTime : existing.endTime,
    timezone: patch.timezone !== undefined ? patch.timezone : existing.timezone,
    isActive: patch.isActive !== undefined ? patch.isActive : existing.isActive,
    sortOrder: patch.sortOrder !== undefined ? patch.sortOrder : existing.sortOrder,
  });

  await db
    .prepare(
      `UPDATE plg_wa_cs_rotator__agents
       SET name = ?, role_label = ?, phone_e164 = ?, weight = ?, schedule_days = ?,
           start_time = ?, end_time = ?, timezone = ?, is_active = ?, sort_order = ?, updated_at = ?
       WHERE id = ?`,
    )
    .bind(
      merged.name,
      merged.roleLabel,
      merged.phoneE164,
      merged.weight,
      serializeScheduleDays(merged.scheduleDays),
      merged.startTime,
      merged.endTime,
      merged.timezone,
      merged.isActive ? 1 : 0,
      merged.sortOrder,
      nowMs,
      existing.id,
    )
    .run();

  return {
    ...existing,
    name: merged.name,
    roleLabel: merged.roleLabel,
    phoneE164: merged.phoneE164,
    weight: merged.weight,
    scheduleDays: merged.scheduleDays,
    startTime: merged.startTime,
    endTime: merged.endTime,
    timezone: merged.timezone,
    isActive: merged.isActive,
    sortOrder: merged.sortOrder,
    updatedAt: nowMs,
  };
}

export async function deleteWaAgent(db: PluginTenantDb, agentId: string): Promise<boolean> {
  const existing = await getWaAgentById(db, agentId);
  if (!existing) return false;
  await db
    .prepare("DELETE FROM plg_wa_cs_rotator__agents WHERE id = ?")
    .bind(existing.id)
    .run();
  return true;
}

async function ensureStateRow(
  db: PluginTenantDb,
  pluginConfig: Readonly<Record<string, unknown>> | undefined,
  nowMs: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO plg_wa_cs_rotator__state (
         id, strategy, cursor_index, weighted_state_json, fallback_whatsapp_phone,
         timezone, fallback_clicks, last_agent_id, state_version, updated_at
       ) VALUES (1, ?, 0, '{}', ?, ?, 0, NULL, 0, ?)`,
    )
    .bind(
      resolveStrategyFromConfig(pluginConfig),
      resolveFallbackFromConfig(pluginConfig),
      resolveTimezoneFromConfig(pluginConfig),
      nowMs,
    )
    .run();
}

export async function getRotatorState(
  db: PluginTenantDb,
  pluginConfig?: Readonly<Record<string, unknown>>,
): Promise<WaRotatorStateRecord> {
  const row = await db
    .prepare(
      `SELECT strategy, cursor_index, weighted_state_json, fallback_whatsapp_phone,
              timezone, fallback_clicks, last_agent_id, state_version, updated_at
       FROM plg_wa_cs_rotator__state
       WHERE id = 1
       LIMIT 1`,
    )
    .first<RawStateRow>();

  const configStrategy = resolveStrategyFromConfig(pluginConfig);
  const configFallback = resolveFallbackFromConfig(pluginConfig);
  const configTimezone = resolveTimezoneFromConfig(pluginConfig);

  if (!row) {
    return {
      strategy: configStrategy,
      cursorIndex: 0,
      weightedState: {},
      fallbackWhatsappPhone: configFallback,
      timezone: configTimezone,
      fallbackClicks: 0,
      lastAgentId: null,
      stateVersion: 0,
      updatedAt: null,
    };
  }

  return {
    strategy: row.strategy === "weighted" ? "weighted" : "round_robin",
    cursorIndex: Number(row.cursor_index ?? 0),
    weightedState: parseWeightedStateJson(row.weighted_state_json),
    fallbackWhatsappPhone: row.fallback_whatsapp_phone || configFallback,
    timezone:
      row.timezone && isValidTimeZone(row.timezone) ? row.timezone : configTimezone,
    fallbackClicks: Number(row.fallback_clicks ?? 0),
    lastAgentId: row.last_agent_id ?? null,
    stateVersion: Number(row.state_version ?? 0),
    updatedAt: Number(row.updated_at),
  };
}

export interface UpdateRotatorSettingsInput {
  readonly strategy?: WaRotationStrategy;
  readonly fallbackWhatsappPhone?: string | null;
  readonly timezone?: string;
  readonly resetCursor?: boolean;
}

/**
 * Updates persistent rotator settings (`strategy`, `fallbackWhatsappPhone`, `timezone`,
 * optional `resetCursor`) in `plg_wa_cs_rotator__state` using optimistic CAS (`state_version`)
 * so `plg_wa_cs_rotator__state` stays the single consistent source of truth under concurrency.
 */
export async function updateRotatorSettings(
  db: PluginTenantDb,
  input: UpdateRotatorSettingsInput,
  nowMs: number,
  pluginConfig?: Readonly<Record<string, unknown>>,
): Promise<WaRotatorStateRecord> {
  if (
    input.strategy !== undefined &&
    input.strategy !== "round_robin" &&
    input.strategy !== "weighted"
  ) {
    throw new WaCsRotatorValidationError(
      "VALIDATION_ERROR",
      'Strategi rotasi harus bernilai "round_robin" atau "weighted".',
    );
  }

  let validatedFallback: string | undefined;
  if (input.fallbackWhatsappPhone !== undefined) {
    if (input.fallbackWhatsappPhone === null || input.fallbackWhatsappPhone.trim().length === 0) {
      validatedFallback = "";
    } else {
      const checked = validateIndonesianWhatsAppNumber(input.fallbackWhatsappPhone);
      if (!checked.ok) {
        throw new WaCsRotatorValidationError(
          "INVALID_PHONE",
          "Nomor WhatsApp cadangan harus format Indonesia yang valid (08... atau +628...).",
        );
      }
      validatedFallback = checked.phone;
    }
  }

  let validatedTimezone: string | undefined;
  if (input.timezone !== undefined) {
    const tz = input.timezone.trim();
    if (!isValidTimeZone(tz)) {
      throw new WaCsRotatorValidationError(
        "INVALID_SCHEDULE",
        `Zona waktu "${tz}" tidak valid. Gunakan zona IANA seperti Asia/Jakarta.`,
      );
    }
    validatedTimezone = tz;
  }

  await ensureStateRow(db, pluginConfig, nowMs);

  for (let attempt = 0; attempt < WA_ROTATOR_CAS_MAX_RETRIES; attempt += 1) {
    const existing = await getRotatorState(db, pluginConfig);
    const nextStrategy = input.strategy ?? existing.strategy;
    const nextFallback =
      validatedFallback !== undefined ? validatedFallback : existing.fallbackWhatsappPhone;
    const nextTimezone = validatedTimezone ?? existing.timezone;
    const nextCursor = input.resetCursor ? 0 : existing.cursorIndex;
    const nextWeighted = input.resetCursor ? {} : existing.weightedState;
    const nextVersion = existing.stateVersion + 1;

    const res = await db
      .prepare(
        `UPDATE plg_wa_cs_rotator__state
         SET strategy = ?,
             cursor_index = ?,
             weighted_state_json = ?,
             fallback_whatsapp_phone = ?,
             timezone = ?,
             state_version = ?,
             updated_at = ?
         WHERE id = 1 AND state_version = ?`,
      )
      .bind(
        nextStrategy,
        nextCursor,
        JSON.stringify(nextWeighted),
        nextFallback,
        nextTimezone,
        nextVersion,
        nowMs,
        existing.stateVersion,
      )
      .run();

    if (Number(res.meta?.changes ?? 0) === 1) {
      return {
        strategy: nextStrategy,
        cursorIndex: nextCursor,
        weightedState: nextWeighted,
        fallbackWhatsappPhone: nextFallback,
        timezone: nextTimezone,
        fallbackClicks: existing.fallbackClicks,
        lastAgentId: existing.lastAgentId,
        stateVersion: nextVersion,
        updatedAt: nowMs,
      };
    }
  }

  throw new WaCsRotatorValidationError(
    "CONFLICT",
    "Konflik pembaruan bersamaan pada pengaturan rotator. Silakan coba lagi.",
  );
}

export interface WaRotationExecutionResult {
  readonly mode: "rotator" | "rotator_fallback";
  readonly rotated: boolean;
  readonly usedFallback: boolean;
  readonly strategyUsed: WaRotationStrategy;
  readonly agent: WaAgentRecord | null;
  readonly targetPhoneE164: string;
  readonly url: string;
  readonly message: string;
  readonly clickId: string | null;
}

async function resolveFallbackPhone(input: {
  readonly primaryWhatsappPhone?: string | null;
  readonly stateFallbackPhone?: string;
  readonly pluginConfig?: Readonly<Record<string, unknown>>;
  readonly tenantDb?: D1Database | null;
}): Promise<string> {
  const candidates: string[] = [
    input.primaryWhatsappPhone ?? "",
    input.stateFallbackPhone ?? "",
    typeof input.pluginConfig?.primaryWhatsappPhone === "string"
      ? input.pluginConfig.primaryWhatsappPhone
      : "",
    typeof input.pluginConfig?.fallbackWhatsappPhone === "string"
      ? input.pluginConfig.fallbackWhatsappPhone
      : "",
  ];
  for (const raw of candidates) {
    if (!raw || raw.trim().length === 0) continue;
    const checked = validateIndonesianWhatsAppNumber(raw);
    if (checked.ok) return checked.phone;
  }
  const fromTenantStore = await readTenantPrimaryWhatsappFromStore(input.tenantDb);
  if (fromTenantStore) return fromTenantStore;

  throw new WaCsRotatorValidationError(
    "INVALID_PHONE",
    "Nomor WhatsApp cadangan (fallback utama) belum diatur atau tidak valid.",
  );
}

/**
 * Selects the next on-shift sales agent (or falls back to primary tenant WA when all
 * agents are off-shift/inactive), atomically persists cursor + per-agent click attribution
 * using optimistic CAS (`state_version`) with bounded retries, updates compact daily
 * aggregates, and prunes raw click logs older than 90 days.
 */
export async function selectAndRecordWaRotation(input: {
  readonly db: PluginTenantDb;
  readonly tenantDb?: D1Database | null;
  readonly config?: Readonly<Record<string, unknown>>;
  readonly primaryWhatsappPhone?: string | null;
  readonly itemTitle?: string;
  readonly itemPrice?: string;
  readonly pageUrl?: string;
  readonly template?: string;
  readonly sourcePath?: string;
  readonly nowMs?: number;
  readonly recordClick?: boolean;
}): Promise<WaRotationExecutionResult> {
  const nowMs = Math.floor(input.nowMs ?? Date.now());
  const recordClick = input.recordClick !== false;
  const safeItemTitle = sanitizeWaItemTitle(input.itemTitle);

  if (recordClick) {
    await ensureStateRow(input.db, input.config, nowMs);
  }

  const maxAttempts = recordClick ? WA_ROTATOR_CAS_MAX_RETRIES : 1;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const [agents, state] = await Promise.all([
      listWaAgents(input.db),
      getRotatorState(input.db, input.config),
    ]);

    const effectiveState: WaRotatorCursorState = {
      strategy: state.strategy,
      cursorIndex: state.cursorIndex,
      weightedState: state.weightedState,
    };

    const decision = selectNextWaAgent({
      agents,
      state: effectiveState,
      nowMs,
    });

    const targetPhoneE164 = decision.selectedAgent
      ? decision.selectedAgent.phoneE164
      : await resolveFallbackPhone({
          primaryWhatsappPhone: input.primaryWhatsappPhone,
          stateFallbackPhone: state.fallbackWhatsappPhone,
          pluginConfig: input.config,
          tenantDb: input.tenantDb,
        });

    const defaultMessage =
      typeof input.config?.defaultMessage === "string" &&
      input.config.defaultMessage.trim().length > 0
        ? input.config.defaultMessage.trim()
        : DEFAULT_WA_CS_ROTATOR_CONFIG.defaultMessage;

    const resolvedTemplate =
      input.template ??
      (safeItemTitle && input.itemPrice
        ? undefined
        : safeItemTitle
          ? "Halo, saya tertarik dengan {{item_title}}.\n{{page_url}}"
          : "{{item_title}}");

    const wa = buildWhatsAppUrl({
      tenantPhone: targetPhoneE164,
      template: resolvedTemplate,
      itemTitle: safeItemTitle ?? defaultMessage,
      itemPrice: input.itemPrice,
      pageUrl: input.pageUrl ?? "https://punyasitus.com/",
    });

    if (!recordClick) {
      return {
        mode: decision.usedFallback ? "rotator_fallback" : "rotator",
        rotated: !decision.usedFallback,
        usedFallback: decision.usedFallback,
        strategyUsed: decision.strategyUsed,
        agent: decision.selectedAgent,
        targetPhoneE164,
        url: wa.url,
        message: wa.message,
        clickId: null,
      };
    }

    // Optimistic Compare-And-Set on `state_version` before committing click attribution!
    const casRes = await input.db
      .prepare(
        `UPDATE plg_wa_cs_rotator__state
         SET strategy = ?,
             cursor_index = ?,
             weighted_state_json = ?,
             fallback_clicks = fallback_clicks + ?,
             last_agent_id = ?,
             state_version = state_version + 1,
             updated_at = ?
         WHERE id = 1 AND state_version = ?`,
      )
      .bind(
        decision.strategyUsed,
        decision.nextCursorIndex,
        JSON.stringify(decision.nextWeightedState),
        decision.usedFallback ? 1 : 0,
        decision.selectedAgent?.id ?? state.lastAgentId,
        nowMs,
        state.stateVersion,
      )
      .run();

    if (Number(casRes.meta?.changes ?? 0) !== 1) {
      // Concurrent rotation updated state first -> retry cleanly with fresh cursor/weights
      continue;
    }

    const dayBucket = formatDayBucketInTimezone(nowMs, state.timezone);
    const sourcePath = sanitizeSourcePath(input.sourcePath);
    const clickId = generateId("clk", nowMs);
    const agentKey = decision.selectedAgent?.id ?? FALLBACK_AGENT_KEY;
    const retentionCutoffMs = nowMs - WA_CLICKS_RETENTION_MS;

    const batchStatements: D1PreparedStatement[] = [
      input.db
        .prepare(
          `INSERT INTO plg_wa_cs_rotator__clicks (
             id, agent_id, target_phone_e164, was_fallback, strategy_used, source_path, day_bucket, clicked_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          clickId,
          decision.selectedAgent?.id ?? null,
          targetPhoneE164,
          decision.usedFallback ? 1 : 0,
          decision.strategyUsed,
          sourcePath,
          dayBucket,
          nowMs,
        ),
      input.db
        .prepare(
          `INSERT INTO plg_wa_cs_rotator__clicks_daily (agent_key, day_bucket, click_count, updated_at)
           VALUES (?, ?, 1, ?)
           ON CONFLICT(agent_key, day_bucket) DO UPDATE SET
             click_count = plg_wa_cs_rotator__clicks_daily.click_count + 1,
             updated_at = excluded.updated_at`,
        )
        .bind(agentKey, dayBucket, nowMs),
      input.db
        .prepare("DELETE FROM plg_wa_cs_rotator__clicks WHERE clicked_at < ?")
        .bind(retentionCutoffMs),
    ];

    if (decision.selectedAgent) {
      batchStatements.push(
        input.db
          .prepare(
            `UPDATE plg_wa_cs_rotator__agents
             SET total_clicks = total_clicks + 1, updated_at = ?
             WHERE id = ?`,
          )
          .bind(nowMs, decision.selectedAgent.id),
      );
    }

    await input.db.batch(batchStatements);

    return {
      mode: decision.usedFallback ? "rotator_fallback" : "rotator",
      rotated: !decision.usedFallback,
      usedFallback: decision.usedFallback,
      strategyUsed: decision.strategyUsed,
      agent: decision.selectedAgent,
      targetPhoneE164,
      url: wa.url,
      message: wa.message,
      clickId,
    };
  }

  throw new WaCsRotatorValidationError(
    "CONFLICT",
    "Terjadi kepadatan permintaan bersamaan pada rotator WhatsApp. Silakan coba lagi.",
  );
}

export async function getWaAttributionStats(
  db: PluginTenantDb,
  pluginConfig?: Readonly<Record<string, unknown>>,
  nowMs: number = Date.now(),
): Promise<WaAttributionStats> {
  const [agents, state, dailyRes] = await Promise.all([
    listWaAgents(db),
    getRotatorState(db, pluginConfig),
    db
      .prepare(
        `SELECT agent_key, day_bucket, click_count
         FROM plg_wa_cs_rotator__clicks_daily
         ORDER BY day_bucket DESC, click_count DESC
         LIMIT 140`,
      )
      .all<{
        readonly agent_key: string;
        readonly day_bucket: string;
        readonly click_count: number;
      }>(),
  ]);

  const shares = computeAttributionShares(agents, state.fallbackClicks, nowMs);

  return {
    strategy: state.strategy,
    totalClicks: shares.totalClicks,
    agentClicks: shares.agentClicks,
    fallbackClicks: shares.fallbackClicks,
    fallbackSharePercent: shares.fallbackSharePercent,
    activeAgentCount: agents.filter((a) => a.isActive).length,
    onShiftAgentCount: agents.filter((a) => isAgentOnShift(a, nowMs)).length,
    agents: shares.agents,
    dailyClicks: (dailyRes.results ?? []).map((r) => ({
      agentId: r.agent_key === FALLBACK_AGENT_KEY ? null : r.agent_key,
      dayBucket: r.day_bucket,
      clicks: Number(r.click_count ?? 0),
    })),
  };
}

export interface ResolveWhatsAppCtaResult {
  readonly mode: "base_single_number" | "rotator" | "rotator_fallback";
  readonly rotated: boolean;
  readonly targetPhoneE164: string;
  readonly url: string;
  readonly message: string;
  readonly agent: WaAgentRecord | null;
  readonly clickId: string | null;
}

/**
 * High-level CTA resolver honoring REQ-014 & REQ-099 instant-revert invariant:
 * - When `pluginActive === false` (disabled or unentitled): executes ZERO `plg_wa_cs_rotator__*`
 *   queries and returns the single-number base WhatsApp flow (`REQ-014`) immediately.
 * - When `pluginActive === true`: routes through the multi-agent rotator with schedule/weight
 *   handling and fallback to `primaryWhatsappPhone` (or TenantStore `business_profile.whatsapp_e164`)
 *   when all agents are off-shift.
 */
export async function resolveWhatsAppCtaWithRotator(input: {
  readonly pluginActive: boolean;
  readonly db?: PluginTenantDb | null;
  readonly tenantDb?: D1Database | null;
  readonly config?: Readonly<Record<string, unknown>>;
  readonly primaryWhatsappPhone?: string | null;
  readonly itemTitle?: string;
  readonly itemPrice?: string;
  readonly pageUrl?: string;
  readonly template?: string;
  readonly sourcePath?: string;
  readonly nowMs?: number;
  readonly recordClick?: boolean;
}): Promise<ResolveWhatsAppCtaResult> {
  const safeItemTitle = sanitizeWaItemTitle(input.itemTitle);

  if (!input.pluginActive || !input.db) {
    const rawPrimary =
      input.primaryWhatsappPhone && input.primaryWhatsappPhone.trim().length > 0
        ? input.primaryWhatsappPhone
        : await readTenantPrimaryWhatsappFromStore(input.tenantDb);
    if (!rawPrimary) {
      throw new WaCsRotatorValidationError(
        "INVALID_PHONE",
        "Nomor WhatsApp utama situs belum diatur.",
      );
    }
    const normalizedPrimary = normalizeIndonesianWhatsAppNumber(rawPrimary);
    const resolvedTemplate =
      input.template ??
      (safeItemTitle && input.itemPrice
        ? undefined
        : safeItemTitle
          ? "Halo, saya tertarik dengan {{item_title}}.\n{{page_url}}"
          : "{{item_title}}");
    const wa = buildWhatsAppUrl({
      tenantPhone: normalizedPrimary,
      template: resolvedTemplate,
      itemTitle: safeItemTitle ?? DEFAULT_WA_CS_ROTATOR_CONFIG.defaultMessage,
      itemPrice: input.itemPrice,
      pageUrl: input.pageUrl ?? "https://punyasitus.com/",
    });
    return {
      mode: "base_single_number",
      rotated: false,
      targetPhoneE164: normalizedPrimary,
      url: wa.url,
      message: wa.message,
      agent: null,
      clickId: null,
    };
  }

  const rotated = await selectAndRecordWaRotation({
    db: input.db,
    tenantDb: input.tenantDb,
    config: input.config,
    primaryWhatsappPhone: input.primaryWhatsappPhone,
    itemTitle: safeItemTitle,
    itemPrice: input.itemPrice,
    pageUrl: input.pageUrl,
    template: input.template,
    sourcePath: input.sourcePath,
    nowMs: input.nowMs,
    recordClick: input.recordClick,
  });

  return {
    mode: rotated.mode,
    rotated: rotated.rotated,
    targetPhoneE164: rotated.targetPhoneE164,
    url: rotated.url,
    message: rotated.message,
    agent: rotated.agent,
    clickId: rotated.clickId,
  };
}

/**
 * First-party public redirect handler for `/wa-rotator` HTTP 302 flows.
 * Returns `302 Found` to the rotated agent's `https://wa.me/<phone>?text=...` URL
 * (or base primary WhatsApp immediately when plugin is inactive/unentitled).
 * Skips cursor/click mutation on HEAD or browser prefetch requests.
 */
export async function handleWaRotatorPublicRedirect(input: {
  readonly pluginActive: boolean;
  readonly db?: PluginTenantDb | null;
  readonly tenantDb?: D1Database | null;
  readonly config?: Readonly<Record<string, unknown>>;
  readonly tenant: PluginTenantSnapshot;
  readonly primaryWhatsappPhone?: string | null;
  readonly request: Request;
  readonly nowMs?: number;
}): Promise<Response> {
  const reqUrl = new URL(input.request.url);
  const itemTitle = sanitizeWaItemTitle(reqUrl.searchParams.get("item"));
  const sourcePath = sanitizeSourcePath(reqUrl.searchParams.get("from") ?? "/");
  const pageUrl = input.tenant.primaryHost
    ? `https://${input.tenant.primaryHost}${sourcePath}`
    : `https://${input.tenant.handle}.situsku.click${sourcePath}`;
  const nonCounting = isNonCountingWaRequest(input.request);

  try {
    const resolved = await resolveWhatsAppCtaWithRotator({
      pluginActive: input.pluginActive,
      db: input.db,
      tenantDb: input.tenantDb,
      config: input.config,
      primaryWhatsappPhone: input.primaryWhatsappPhone,
      itemTitle,
      pageUrl,
      sourcePath,
      nowMs: input.nowMs,
      recordClick: input.pluginActive && !nonCounting,
    });

    return new Response(null, {
      status: 302,
      headers: {
        Location: resolved.url,
        "Cache-Control": "private, no-store",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "X-WA-Rotator-Mode": resolved.mode,
      },
    });
  } catch (err) {
    if (err instanceof WaCsRotatorValidationError) {
      const status = err.code === "CONFLICT" ? 409 : 422;
      return Response.json(
        { error: { code: err.code, message: err.message } },
        { status, headers: { "Cache-Control": "private, no-store" } },
      );
    }
    return Response.json(
      { error: { code: "INTERNAL_ERROR", message: "Gagal memproses pengalihan WhatsApp." } },
      { status: 500, headers: { "Cache-Control": "private, no-store" } },
    );
  }
}

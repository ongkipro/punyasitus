import {
  isValidTimeZone,
  parseHhMmToMinutes,
  WA_CS_DEFAULT_TIMEZONE,
  type WaRotationStrategy,
} from "./validation.ts";

/**
 * Pure deterministic WhatsApp CS rotation & active-hour schedule engine (`REQ-099`, `TASK-099`).
 *
 * Supports:
 * 1. Timezone-aware per-agent active-hour schedules (default `Asia/Jakarta` WIB),
 *    including standard daytime shifts (`08:00-17:00`), 24h shifts (`00:00-24:00`),
 *    and overnight shifts (`22:00-06:00`).
 * 2. Round-robin with persistent monotonic cursor.
 * 3. Smooth Weighted Round-Robin (Nginx SWRR) — deterministic, exact weight ratios,
 *    even interleaving across agents without clumping.
 * 4. Clean fallback signal when all agents are off-shift or inactive.
 */

export interface WaRotatorAgentLike {
  readonly id: string;
  readonly name: string;
  readonly roleLabel: string;
  readonly phoneE164: string;
  readonly weight: number;
  readonly scheduleDays: readonly number[];
  readonly startTime: string;
  readonly endTime: string;
  readonly timezone: string;
  readonly isActive: boolean;
  readonly sortOrder: number;
}

export interface WaRotatorCursorState {
  readonly strategy: WaRotationStrategy;
  readonly cursorIndex: number;
  readonly weightedState: Readonly<Record<string, number>>;
}

export interface WaRotationDecision<T extends WaRotatorAgentLike = WaRotatorAgentLike> {
  readonly selectedAgent: T | null;
  readonly usedFallback: boolean;
  readonly eligibleCount: number;
  readonly strategyUsed: WaRotationStrategy;
  readonly nextCursorIndex: number;
  readonly nextWeightedState: Readonly<Record<string, number>>;
}

const WEEKDAY_MAP: Readonly<Record<string, number>> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

export interface LocalClockSnapshot {
  readonly dayOfWeek: number; // 0 = Sun ... 6 = Sat
  readonly minutesOfDay: number; // 0 ... 1439
}

export function getLocalClockInTimezone(nowMs: number, timezone: string): LocalClockSnapshot {
  const tz = isValidTimeZone(timezone) ? timezone : WA_CS_DEFAULT_TIMEZONE;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(nowMs));

  const weekdayStr = parts.find((p) => p.type === "weekday")?.value ?? "Mon";
  const hourNum = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minNum = Number(parts.find((p) => p.type === "minute")?.value ?? "0");

  const dayOfWeek = WEEKDAY_MAP[weekdayStr] ?? 1;
  const normalizedHour = hourNum === 24 ? 0 : hourNum;

  return {
    dayOfWeek,
    minutesOfDay: normalizedHour * 60 + minNum,
  };
}

/**
 * Evaluates whether a single sales agent is active and currently within their scheduled
 * active-hour window at `nowMs` in the agent's configured timezone.
 */
export function isAgentOnShift(agent: WaRotatorAgentLike, nowMs: number): boolean {
  if (!agent.isActive) return false;
  if (agent.scheduleDays.length === 0) return false;

  const startMin = parseHhMmToMinutes(agent.startTime, false);
  const endMin = parseHhMmToMinutes(agent.endTime, true);
  if (startMin === null || endMin === null) return false;

  const clock = getLocalClockInTimezone(nowMs, agent.timezone);
  const daySet = new Set(agent.scheduleDays);

  // Full 24h window on scheduled days (e.g. 00:00 - 24:00 or start === end)
  if (startMin === endMin || (startMin === 0 && endMin === 24 * 60)) {
    return daySet.has(clock.dayOfWeek);
  }

  // Standard daytime shift (e.g. 08:00 - 17:00)
  if (startMin < endMin) {
    return (
      daySet.has(clock.dayOfWeek) &&
      clock.minutesOfDay >= startMin &&
      clock.minutesOfDay < endMin
    );
  }

  // Overnight shift (e.g. 22:00 - 06:00)
  const prevDay = (clock.dayOfWeek + 6) % 7;
  const inLatePart = daySet.has(clock.dayOfWeek) && clock.minutesOfDay >= startMin;
  const inEarlyPart = daySet.has(prevDay) && clock.minutesOfDay < endMin;
  return inLatePart || inEarlyPart;
}

function sortAgentsDeterministically<T extends WaRotatorAgentLike>(agents: readonly T[]): T[] {
  return [...agents].sort((a, b) => {
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    return a.id.localeCompare(b.id);
  });
}

/**
 * Selects the next eligible agent using either `round_robin` or Smooth Weighted Round-Robin (`weighted`),
 * strictly skipping inactive or off-shift agents and signalling fallback when none are eligible.
 */
export function selectNextWaAgent<T extends WaRotatorAgentLike>(input: {
  readonly agents: readonly T[];
  readonly state: WaRotatorCursorState;
  readonly nowMs: number;
}): WaRotationDecision<T> {
  const ordered = sortAgentsDeterministically(input.agents);
  const eligible = ordered.filter((agent) => isAgentOnShift(agent, input.nowMs));

  if (eligible.length === 0) {
    return {
      selectedAgent: null,
      usedFallback: true,
      eligibleCount: 0,
      strategyUsed: input.state.strategy,
      nextCursorIndex: input.state.cursorIndex,
      nextWeightedState: { ...input.state.weightedState },
    };
  }

  if (input.state.strategy === "round_robin") {
    const idx = Math.max(0, Math.trunc(input.state.cursorIndex)) % eligible.length;
    const chosen = eligible[idx]!;
    return {
      selectedAgent: chosen,
      usedFallback: false,
      eligibleCount: eligible.length,
      strategyUsed: "round_robin",
      nextCursorIndex: Math.max(0, Math.trunc(input.state.cursorIndex)) + 1,
      nextWeightedState: { ...input.state.weightedState },
    };
  }

  // Smooth Weighted Round-Robin (Nginx SWRR)
  const nextWeights: Record<string, number> = {};
  let totalWeight = 0;

  for (const agent of eligible) {
    const effWeight = Math.max(1, Math.trunc(agent.weight));
    totalWeight += effWeight;
    const prevCurrent = Number(input.state.weightedState[agent.id] ?? 0);
    nextWeights[agent.id] = (Number.isFinite(prevCurrent) ? prevCurrent : 0) + effWeight;
  }

  let chosen = eligible[0]!;
  let bestScore = nextWeights[chosen.id]!;

  for (let i = 1; i < eligible.length; i += 1) {
    const candidate = eligible[i]!;
    const score = nextWeights[candidate.id]!;
    if (score > bestScore) {
      bestScore = score;
      chosen = candidate;
    }
  }

  nextWeights[chosen.id] = bestScore - totalWeight;

  // Preserve off-shift existing agents' bounded state if they still exist in `ordered`
  const existingIds = new Set(ordered.map((a) => a.id));
  for (const [id, val] of Object.entries(input.state.weightedState)) {
    if (existingIds.has(id) && !(id in nextWeights) && Number.isFinite(val)) {
      nextWeights[id] = val;
    }
  }

  return {
    selectedAgent: chosen,
    usedFallback: false,
    eligibleCount: eligible.length,
    strategyUsed: "weighted",
    nextCursorIndex: Math.max(0, Math.trunc(input.state.cursorIndex)) + 1,
    nextWeightedState: nextWeights,
  };
}

export interface AgentAttributionShare {
  readonly agentId: string;
  readonly name: string;
  readonly roleLabel: string;
  readonly phoneE164: string;
  readonly weight: number;
  readonly isActive: boolean;
  readonly isOnShiftNow: boolean;
  readonly totalClicks: number;
  readonly sharePercent: number;
}

export function computeAttributionShares(
  agents: readonly (WaRotatorAgentLike & { readonly totalClicks: number })[],
  fallbackClicks: number,
  nowMs: number,
): {
  readonly totalClicks: number;
  readonly agentClicks: number;
  readonly fallbackClicks: number;
  readonly fallbackSharePercent: number;
  readonly agents: readonly AgentAttributionShare[];
} {
  const agentClicks = agents.reduce((acc, a) => acc + Math.max(0, a.totalClicks), 0);
  const safeFallback = Math.max(0, fallbackClicks);
  const totalClicks = agentClicks + safeFallback;

  const mapped: AgentAttributionShare[] = agents.map((a) => ({
    agentId: a.id,
    name: a.name,
    roleLabel: a.roleLabel,
    phoneE164: a.phoneE164,
    weight: a.weight,
    isActive: a.isActive,
    isOnShiftNow: isAgentOnShift(a, nowMs),
    totalClicks: a.totalClicks,
    sharePercent:
      totalClicks > 0 ? Math.round((a.totalClicks / totalClicks) * 1000) / 10 : 0,
  }));

  return {
    totalClicks,
    agentClicks,
    fallbackClicks: safeFallback,
    fallbackSharePercent:
      totalClicks > 0 ? Math.round((safeFallback / totalClicks) * 1000) / 10 : 0,
    agents: mapped,
  };
}

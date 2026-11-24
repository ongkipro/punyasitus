import type { PluginTenantDb, PluginTenantSnapshot } from "@punyasitus/core/plugins/index";
import {
  BIO_LINKS_DEFAULT_ACCENT,
  BIO_LINKS_MAX_LINKS,
  BioLinksValidationError,
  formatJakartaDayBucket,
  isValidBioLinkId,
  validateBioLinkCreateInput,
  validateBioLinkProfileInput,
  validateBioLinkUrl,
  type BioLinkCreateInput,
  type BioLinkProfileInput,
} from "./validation.ts";

/**
 * Tenant-isolated database service & first-party click tracker for `bio-links`.
 * Every query targets ONLY `plg_bio_links__*` tables via `PluginTenantDb`.
 * Zero third-party trackers, zero cookies, zero PII stored.
 */

export interface BioLinkProfileRecord {
  readonly displayName: string;
  readonly headline: string;
  readonly bioText: string;
  readonly avatarUrl: string;
  readonly themeAccent: string;
  readonly whatsappPhone: string;
  readonly whatsappLabel: string;
  readonly whatsappMessage: string;
  readonly showWhatsappButton: boolean;
  readonly updatedAt: number | null;
}

export interface BioLinkItemRecord {
  readonly id: string;
  readonly label: string;
  readonly url: string;
  readonly subtitle: string;
  readonly badge: string;
  readonly sortOrder: number;
  readonly isActive: boolean;
  readonly clickCount: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface BioLinkDailyStat {
  readonly linkId: string;
  readonly dayBucket: string;
  readonly clickCount: number;
}

export interface BioLinksStatsSummary {
  readonly totalLinks: number;
  readonly activeLinks: number;
  readonly totalClicks: number;
  readonly topLinkId: string | null;
  readonly dailyClicks: readonly BioLinkDailyStat[];
}

interface RawConfigRow {
  readonly display_name: string;
  readonly headline: string;
  readonly bio_text: string;
  readonly avatar_url: string;
  readonly theme_accent: string;
  readonly whatsapp_phone: string;
  readonly whatsapp_label: string;
  readonly whatsapp_message: string;
  readonly show_whatsapp_button: number;
  readonly updated_at: number;
}

interface RawItemRow {
  readonly id: string;
  readonly label: string;
  readonly url: string;
  readonly subtitle: string;
  readonly badge: string;
  readonly sort_order: number;
  readonly is_active: number;
  readonly click_count: number;
  readonly created_at: number;
  readonly updated_at: number;
}

function mapItemRow(row: RawItemRow): BioLinkItemRecord {
  return {
    id: row.id,
    label: row.label,
    url: row.url,
    subtitle: row.subtitle ?? "",
    badge: row.badge ?? "",
    sortOrder: Number(row.sort_order ?? 0),
    isActive: Number(row.is_active) === 1,
    clickCount: Number(row.click_count ?? 0),
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
  };
}

function generateBioLinkId(nowMs: number): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `bl_${nowMs.toString(36)}_${hex}`;
}

export async function getBioLinksProfile(
  db: PluginTenantDb,
  tenant: PluginTenantSnapshot,
  pluginConfig?: Readonly<Record<string, unknown>>,
): Promise<BioLinkProfileRecord> {
  const row = await db
    .prepare(
      `SELECT display_name, headline, bio_text, avatar_url, theme_accent,
              whatsapp_phone, whatsapp_label, whatsapp_message, show_whatsapp_button, updated_at
       FROM plg_bio_links__config
       WHERE id = 1
       LIMIT 1`,
    )
    .first<RawConfigRow>();

  const cfgDisplayName =
    typeof pluginConfig?.displayName === "string" && pluginConfig.displayName.trim().length > 0
      ? pluginConfig.displayName.trim()
      : tenant.name;
  const cfgHeadline =
    typeof pluginConfig?.headline === "string" ? pluginConfig.headline.trim() : "";
  const cfgAccent =
    typeof pluginConfig?.themeAccent === "string" && /^#[0-9a-fA-F]{6}$/.test(pluginConfig.themeAccent)
      ? pluginConfig.themeAccent.toUpperCase()
      : BIO_LINKS_DEFAULT_ACCENT;
  const cfgWhatsapp =
    typeof pluginConfig?.whatsappPhone === "string" ? pluginConfig.whatsappPhone.trim() : "";
  const cfgShowWa =
    typeof pluginConfig?.showWhatsappButton === "boolean" ? pluginConfig.showWhatsappButton : true;

  if (!row) {
    return {
      displayName: cfgDisplayName,
      headline: cfgHeadline,
      bioText: "",
      avatarUrl: "",
      themeAccent: cfgAccent,
      whatsappPhone: cfgWhatsapp,
      whatsappLabel: "Hubungi via WhatsApp",
      whatsappMessage: "",
      showWhatsappButton: cfgShowWa,
      updatedAt: null,
    };
  }

  return {
    displayName: row.display_name.trim() || cfgDisplayName,
    headline: row.headline || cfgHeadline,
    bioText: row.bio_text || "",
    avatarUrl: row.avatar_url || "",
    themeAccent: row.theme_accent || cfgAccent,
    whatsappPhone: row.whatsapp_phone || cfgWhatsapp,
    whatsappLabel: row.whatsapp_label || "Hubungi via WhatsApp",
    whatsappMessage: row.whatsapp_message || "",
    showWhatsappButton: Number(row.show_whatsapp_button) === 1,
    updatedAt: Number(row.updated_at),
  };
}

/**
 * Returns true when an incoming request is a HEAD probe or browser prefetch/prerender
 * that must NEVER mutate click counters.
 */
export function isNonCountingBioRequest(request: Request): boolean {
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

export async function upsertBioLinksProfile(
  db: PluginTenantDb,
  input: BioLinkProfileInput,
  nowMs: number,
): Promise<BioLinkProfileRecord> {
  // Preserve omitted optional fields (e.g. avatarUrl, whatsappMessage) on partial saves
  const existing = await db
    .prepare(
      `SELECT display_name, headline, bio_text, avatar_url, theme_accent,
              whatsapp_phone, whatsapp_label, whatsapp_message, show_whatsapp_button, updated_at
       FROM plg_bio_links__config
       WHERE id = 1
       LIMIT 1`,
    )
    .first<RawConfigRow>();

  const mergedInput: BioLinkProfileInput = {
    displayName:
      input.displayName !== undefined ? input.displayName : (existing?.display_name ?? ""),
    headline: input.headline !== undefined ? input.headline : (existing?.headline ?? ""),
    bioText: input.bioText !== undefined ? input.bioText : (existing?.bio_text ?? ""),
    avatarUrl:
      input.avatarUrl !== undefined
        ? (input.avatarUrl === null ? "" : input.avatarUrl)
        : (existing?.avatar_url ?? ""),
    themeAccent:
      input.themeAccent !== undefined
        ? input.themeAccent
        : (existing?.theme_accent ?? BIO_LINKS_DEFAULT_ACCENT),
    whatsappPhone:
      input.whatsappPhone !== undefined
        ? (input.whatsappPhone === null ? "" : input.whatsappPhone)
        : (existing?.whatsapp_phone ?? ""),
    whatsappLabel:
      input.whatsappLabel !== undefined
        ? input.whatsappLabel
        : (existing?.whatsapp_label ?? "Hubungi via WhatsApp"),
    whatsappMessage:
      input.whatsappMessage !== undefined
        ? (input.whatsappMessage === null ? "" : input.whatsappMessage)
        : (existing?.whatsapp_message ?? ""),
    showWhatsappButton:
      input.showWhatsappButton !== undefined
        ? input.showWhatsappButton
        : existing
          ? Number(existing.show_whatsapp_button) === 1
          : true,
  };

  const validated = validateBioLinkProfileInput(mergedInput);
  await db
    .prepare(
      `INSERT INTO plg_bio_links__config (
         id, display_name, headline, bio_text, avatar_url, theme_accent,
         whatsapp_phone, whatsapp_label, whatsapp_message, show_whatsapp_button, updated_at
       ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         display_name = excluded.display_name,
         headline = excluded.headline,
         bio_text = excluded.bio_text,
         avatar_url = excluded.avatar_url,
         theme_accent = excluded.theme_accent,
         whatsapp_phone = excluded.whatsapp_phone,
         whatsapp_label = excluded.whatsapp_label,
         whatsapp_message = excluded.whatsapp_message,
         show_whatsapp_button = excluded.show_whatsapp_button,
         updated_at = excluded.updated_at`,
    )
    .bind(
      validated.displayName,
      validated.headline,
      validated.bioText,
      validated.avatarUrl,
      validated.themeAccent,
      validated.whatsappPhone,
      validated.whatsappLabel,
      validated.whatsappMessage,
      validated.showWhatsappButton ? 1 : 0,
      nowMs,
    )
    .run();

  return {
    ...validated,
    updatedAt: nowMs,
  };
}

export async function listBioLinks(
  db: PluginTenantDb,
  options?: { readonly activeOnly?: boolean },
): Promise<BioLinkItemRecord[]> {
  const sql = options?.activeOnly
    ? `SELECT id, label, url, subtitle, badge, sort_order, is_active, click_count, created_at, updated_at
       FROM plg_bio_links__items
       WHERE is_active = 1
       ORDER BY sort_order ASC, created_at ASC, id ASC`
    : `SELECT id, label, url, subtitle, badge, sort_order, is_active, click_count, created_at, updated_at
       FROM plg_bio_links__items
       ORDER BY sort_order ASC, created_at ASC, id ASC`;

  const result = await db.prepare(sql).all<RawItemRow>();
  return (result.results ?? []).map(mapItemRow);
}

export async function getBioLinkById(
  db: PluginTenantDb,
  linkId: string,
): Promise<BioLinkItemRecord | null> {
  if (!isValidBioLinkId(linkId)) return null;
  const row = await db
    .prepare(
      `SELECT id, label, url, subtitle, badge, sort_order, is_active, click_count, created_at, updated_at
       FROM plg_bio_links__items
       WHERE id = ?
       LIMIT 1`,
    )
    .bind(linkId.trim().toLowerCase())
    .first<RawItemRow>();
  return row ? mapItemRow(row) : null;
}

export async function createBioLink(
  db: PluginTenantDb,
  input: BioLinkCreateInput,
  nowMs: number,
): Promise<BioLinkItemRecord> {
  const validated = validateBioLinkCreateInput(input);
  const countRow = await db
    .prepare("SELECT COUNT(*) AS total FROM plg_bio_links__items")
    .first<{ readonly total: number }>();
  const currentTotal = Number(countRow?.total ?? 0);
  if (currentTotal >= BIO_LINKS_MAX_LINKS) {
    throw new BioLinksValidationError(
      "VALIDATION_ERROR",
      `Maksimal ${BIO_LINKS_MAX_LINKS} tautan bio per situs.`,
    );
  }

  const sortOrder =
    typeof input.sortOrder === "number" ? validated.sortOrder : currentTotal;
  const id = generateBioLinkId(nowMs);

  await db
    .prepare(
      `INSERT INTO plg_bio_links__items (
         id, label, url, subtitle, badge, sort_order, is_active, click_count, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    )
    .bind(
      id,
      validated.label,
      validated.url,
      validated.subtitle,
      validated.badge,
      sortOrder,
      validated.isActive ? 1 : 0,
      nowMs,
      nowMs,
    )
    .run();

  return {
    id,
    label: validated.label,
    url: validated.url,
    subtitle: validated.subtitle,
    badge: validated.badge,
    sortOrder,
    isActive: validated.isActive,
    clickCount: 0,
    createdAt: nowMs,
    updatedAt: nowMs,
  };
}

export async function updateBioLink(
  db: PluginTenantDb,
  linkId: string,
  patch: Partial<BioLinkCreateInput>,
  nowMs: number,
): Promise<BioLinkItemRecord | null> {
  const existing = await getBioLinkById(db, linkId);
  if (!existing) return null;

  const merged = validateBioLinkCreateInput({
    label: patch.label !== undefined ? patch.label : existing.label,
    url: patch.url !== undefined ? patch.url : existing.url,
    subtitle: patch.subtitle !== undefined ? patch.subtitle : existing.subtitle,
    badge: patch.badge !== undefined ? patch.badge : existing.badge,
    sortOrder: patch.sortOrder !== undefined ? patch.sortOrder : existing.sortOrder,
    isActive: patch.isActive !== undefined ? patch.isActive : existing.isActive,
  });

  await db
    .prepare(
      `UPDATE plg_bio_links__items
       SET label = ?, url = ?, subtitle = ?, badge = ?, sort_order = ?, is_active = ?, updated_at = ?
       WHERE id = ?`,
    )
    .bind(
      merged.label,
      merged.url,
      merged.subtitle,
      merged.badge,
      merged.sortOrder,
      merged.isActive ? 1 : 0,
      nowMs,
      existing.id,
    )
    .run();

  return {
    ...existing,
    label: merged.label,
    url: merged.url,
    subtitle: merged.subtitle,
    badge: merged.badge,
    sortOrder: merged.sortOrder,
    isActive: merged.isActive,
    updatedAt: nowMs,
  };
}

export async function deleteBioLink(db: PluginTenantDb, linkId: string): Promise<boolean> {
  const existing = await getBioLinkById(db, linkId);
  if (!existing) return false;

  await db
    .prepare("DELETE FROM plg_bio_links__clicks_daily WHERE link_id = ?")
    .bind(existing.id)
    .run();
  await db
    .prepare("DELETE FROM plg_bio_links__items WHERE id = ?")
    .bind(existing.id)
    .run();
  return true;
}

export async function reorderBioLinks(
  db: PluginTenantDb,
  orderedIds: readonly string[],
  nowMs: number,
): Promise<BioLinkItemRecord[]> {
  const existing = await listBioLinks(db);
  const existingIds = new Set(existing.map((i) => i.id));
  const cleanOrder: string[] = [];
  const seen = new Set<string>();

  for (const rawId of orderedIds) {
    const id = typeof rawId === "string" ? rawId.trim().toLowerCase() : "";
    if (!existingIds.has(id) || seen.has(id)) continue;
    seen.add(id);
    cleanOrder.push(id);
  }
  for (const item of existing) {
    if (!seen.has(item.id)) {
      cleanOrder.push(item.id);
    }
  }

  if (cleanOrder.length > 0) {
    const statements = cleanOrder.map((id, idx) =>
      db
        .prepare("UPDATE plg_bio_links__items SET sort_order = ?, updated_at = ? WHERE id = ?")
        .bind(idx, nowMs, id),
    );
    await db.batch(statements);
  }

  return listBioLinks(db);
}

export type RecordBioLinkClickResult =
  | {
      readonly ok: true;
      readonly linkId: string;
      readonly label: string;
      readonly targetUrl: string;
      readonly clickCount: number;
      readonly dayBucket: string;
    }
  | {
      readonly ok: false;
      readonly reason: "not_found" | "inactive" | "unsafe_url";
    };

/**
 * Records a first-party click strictly for an existing ACTIVE link belonging to this tenant.
 * Never trusts query-supplied redirect URLs — eliminates open-redirect vulnerabilities by design.
 */
export async function recordBioLinkClick(
  db: PluginTenantDb,
  linkId: string,
  nowMs: number = Date.now(),
  options?: { readonly skipCount?: boolean },
): Promise<RecordBioLinkClickResult> {
  const item = await getBioLinkById(db, linkId);
  if (!item) {
    return { ok: false, reason: "not_found" };
  }
  if (!item.isActive) {
    return { ok: false, reason: "inactive" };
  }

  const checked = validateBioLinkUrl(item.url);
  if (!checked.ok) {
    return { ok: false, reason: "unsafe_url" };
  }

  const dayBucket = formatJakartaDayBucket(nowMs);
  if (options?.skipCount) {
    return {
      ok: true,
      linkId: item.id,
      label: item.label,
      targetUrl: checked.url,
      clickCount: item.clickCount,
      dayBucket,
    };
  }

  await db.batch([
    db
      .prepare(
        `UPDATE plg_bio_links__items
         SET click_count = click_count + 1, updated_at = ?
         WHERE id = ? AND is_active = 1`,
      )
      .bind(nowMs, item.id),
    db
      .prepare(
        `INSERT INTO plg_bio_links__clicks_daily (link_id, day_bucket, click_count, updated_at)
         VALUES (?, ?, 1, ?)
         ON CONFLICT(link_id, day_bucket) DO UPDATE SET
           click_count = plg_bio_links__clicks_daily.click_count + 1,
           updated_at = excluded.updated_at`,
      )
      .bind(item.id, dayBucket, nowMs),
  ]);

  return {
    ok: true,
    linkId: item.id,
    label: item.label,
    targetUrl: checked.url,
    clickCount: item.clickCount + 1,
    dayBucket,
  };
}

export async function getBioLinkStats(
  db: PluginTenantDb,
  options?: { readonly limitDays?: number },
): Promise<BioLinksStatsSummary> {
  const items = await listBioLinks(db);
  const limitDays = Math.max(1, Math.min(90, options?.limitDays ?? 14));

  const dailyRes = await db
    .prepare(
      `SELECT link_id, day_bucket, click_count
       FROM plg_bio_links__clicks_daily
       ORDER BY day_bucket DESC, click_count DESC
       LIMIT ?`,
    )
    .bind(limitDays * 20)
    .all<{
      readonly link_id: string;
      readonly day_bucket: string;
      readonly click_count: number;
    }>();

  let totalClicks = 0;
  let activeLinks = 0;
  let topLinkId: string | null = null;
  let topClicks = -1;

  for (const item of items) {
    totalClicks += item.clickCount;
    if (item.isActive) activeLinks += 1;
    if (item.clickCount > topClicks) {
      topClicks = item.clickCount;
      topLinkId = item.id;
    }
  }

  return {
    totalLinks: items.length,
    activeLinks,
    totalClicks,
    topLinkId: totalClicks > 0 ? topLinkId : null,
    dailyClicks: (dailyRes.results ?? []).map((row) => ({
      linkId: row.link_id,
      dayBucket: row.day_bucket,
      clickCount: Number(row.click_count ?? 0),
    })),
  };
}

/**
 * First-party click-tracking HTTP handler (`/api/plugins/bio-links/click?id=<linkId>`).
 *
 * Security invariants:
 * - Rejects arbitrary `?url=` / `?target=` / `?next=` open-redirect parameters.
 * - Looks up `id` strictly inside the resolved tenant's `PluginTenantDb` (`plg_bio_links__items`).
 * - Re-validates stored URL against the safe protocol allowlist before issuing `302 Found`.
 * - Stores zero visitor PII (no IP, no user-agent, no cookies).
 */
export async function handleBioLinkClickRedirect(input: {
  readonly db: PluginTenantDb;
  readonly request: Request;
  readonly nowMs?: number;
}): Promise<Response> {
  const url = new URL(input.request.url);
  const method = input.request.method.toUpperCase();

  // Explicitly reject open-redirect smuggling attempts via query parameters
  if (
    url.searchParams.has("url") ||
    url.searchParams.has("target") ||
    url.searchParams.has("next") ||
    url.searchParams.has("redirect")
  ) {
    return Response.json(
      {
        error: {
          code: "OPEN_REDIRECT_REJECTED",
          message: "Parameter pengalihan eksternal tidak diizinkan. Gunakan ID tautan resmi.",
        },
      },
      {
        status: 400,
        headers: {
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
        },
      },
    );
  }

  let linkId = url.searchParams.get("id") ?? "";
  if (!linkId && method === "POST") {
    try {
      const body = (await input.request.json()) as { readonly id?: unknown; readonly linkId?: unknown };
      if (typeof body.id === "string") linkId = body.id;
      else if (typeof body.linkId === "string") linkId = body.linkId;
    } catch {
      return Response.json(
        { error: { code: "VALIDATION_ERROR", message: "Format JSON tidak valid." } },
        { status: 400, headers: { "Cache-Control": "private, no-store" } },
      );
    }
  }

  const cleanId = linkId.trim().toLowerCase();
  if (!isValidBioLinkId(cleanId)) {
    return Response.json(
      { error: { code: "NOT_FOUND", message: "Tautan bio tidak ditemukan." } },
      {
        status: 404,
        headers: {
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
        },
      },
    );
  }

  const recorded = await recordBioLinkClick(input.db, cleanId, input.nowMs ?? Date.now(), {
    skipCount: isNonCountingBioRequest(input.request),
  });
  if (!recorded.ok) {
    return Response.json(
      { error: { code: "NOT_FOUND", message: "Tautan bio tidak ditemukan atau tidak aktif." } },
      {
        status: 404,
        headers: {
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
        },
      },
    );
  }

  if (method === "POST") {
    return Response.json(
      {
        ok: true,
        linkId: recorded.linkId,
        targetUrl: recorded.targetUrl,
        clickCount: recorded.clickCount,
        dayBucket: recorded.dayBucket,
      },
      {
        status: 200,
        headers: {
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
        },
      },
    );
  }

  return new Response(null, {
    status: 302,
    headers: {
      Location: recorded.targetUrl,
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

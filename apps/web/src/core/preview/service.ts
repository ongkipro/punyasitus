import {
  PublicationNotFoundError,
  sanitizePublishedHtmlFragment,
  StaleRevisionError,
  type BusinessProfileSnapshot,
  type OfferingSnapshot,
  type PageLayoutMode,
  type PageSnapshot,
  type PostSnapshot,
  type SiteSettingsSnapshot,
} from "@punyasitus/core/content/index";
import {
  extractReferencedMediaIds,
  MAX_PREVIEW_HTML_BYTES,
  neutralizePreviewHtml,
  PreviewPayloadTooLargeError,
  PreviewThemeError,
  PreviewValidationError,
  type PreviewMediaReference,
  type PreviewResourceKind,
  type ValidatedDraftPreviewInput,
} from "@punyasitus/core/preview/index";
import { PLATFORM_THEME_IDS, type ThemeConfigSnapshot } from "@punyasitus/core/theme/index";
import { getDraftResourceForAdmin } from "@punyasitus/db/publication/index";
import {
  loadPublishedTenantShellData,
  type PreviewShellDraftOverride,
  type TenantShellData,
} from "../public-data.ts";

/**
 * In-Process Draft Preview Resolver & Document Composer
 * (REQ-036, REQ-001, REQ-034, REQ-039; PLAN §14; TASK-050).
 *
 * Security & Isolation Invariants:
 * - Loads drafts ONLY from the server-authorized tenant's own `TenantStore`.
 * - Verifies EVERY referenced `mediaId` exists as a `ready`, non-trashed asset in THIS
 *   tenant's own `media_items` table (cross-tenant media IDs always fail with 422).
 * - Enforces optimistic `expectedVersion` checks (409 STALE_VERSION on mismatch).
 * - Validates theme registration/entitlement (rejects unregistered/ungranted custom themes).
 * - Reuses `loadPublishedTenantShellData(..., { previewMode: true, previewDraftOverride })`
 *   and the EXACT same `apps/web/src/themes/default/Layout.astro` theme shell in-process.
 * - Never writes to DB or edge cache; neutralizes scripts, forms, and external navigation.
 */

const PLATFORM_THEME_SET: ReadonlySet<string> = new Set<string>(PLATFORM_THEME_IDS);

export interface ResolvedPreviewMedia {
  readonly id: number;
  readonly kind: "image" | "video";
  readonly r2Key: string;
  readonly altText: string;
  readonly width: number | null;
  readonly height: number | null;
}

export interface PreviewRenderModel {
  readonly shell: TenantShellData;
  readonly resourceKind: PreviewResourceKind;
  readonly resourceId: number | string | null;
  readonly version: number;
  readonly themeId: string;
  readonly layoutMode: PageLayoutMode;
  readonly pageTitle: string;
  readonly pageDescription: string | null;
  readonly currentPath: string;
  readonly bodyHtml: string;
  readonly logoUrl: string | null;
  readonly hasUnpublishedChanges: boolean;
  readonly verifiedMedia: ReadonlyMap<number, ResolvedPreviewMedia>;
}

export interface RenderPreviewShellDocumentFn {
  (model: PreviewRenderModel): Promise<string> | string;
}

export interface LoadTenantDraftPreviewParams {
  readonly platformDb: D1Database | null | undefined;
  readonly tenantDb: D1Database;
  readonly tenantId: string;
  readonly tenantHandle: string;
  readonly tenantName: string;
  readonly input: ValidatedDraftPreviewInput;
}

export interface RenderTenantDraftPreviewResult {
  readonly html: string;
  readonly model: PreviewRenderModel;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatIdr(amount: number): string {
  return `Rp ${new Intl.NumberFormat("id-ID").format(amount)}`;
}

/**
 * Checks whether a requested `themeId` is either one of the 6 built-in platform themes
 * or an active registered theme granted to `tenantId` (or a `paid_once` catalog theme
 * eligible for pre-purchase preview per DESIGN.md §7).
 * Unregistered or ungranted `custom-*` themes fail visibly with `422 UNREGISTERED_THEME`.
 */
export async function verifyPreviewThemeRegistered(
  platformDb: D1Database | null | undefined,
  tenantId: string,
  themeId: string,
): Promise<void> {
  if (PLATFORM_THEME_SET.has(themeId)) {
    return;
  }

  if (!platformDb) {
    throw new PreviewThemeError(themeId);
  }

  const row = await platformDb
    .prepare(
      `SELECT tc.id AS id, tc.tier AS tier, tc.active AS active, tte.id AS grant_id
       FROM theme_catalog tc
       LEFT JOIN tenant_theme_entitlements tte
         ON tte.theme_id = tc.id AND tte.tenant_id = ?
       WHERE (tc.id = ? OR tc.slug = ?) AND tc.active = 1
       LIMIT 1`,
    )
    .bind(tenantId, themeId, themeId)
    .first<{
      readonly id: string;
      readonly tier: string;
      readonly active: number;
      readonly grant_id: string | null;
    }>();

  if (!row) {
    throw new PreviewThemeError(themeId);
  }

  // Custom client themes require an explicit entitlement grant for this tenant.
  if (row.tier === "custom" && !row.grant_id) {
    throw new PreviewThemeError(
      themeId,
      `Tema kustom "${themeId}" belum diberikan akses untuk situs ini.`,
    );
  }
}

interface RawMediaOwnershipRow {
  readonly id: number;
  readonly kind: "image" | "video";
  readonly r2_key: string;
  readonly alt_text: string;
  readonly width: number | null;
  readonly height: number | null;
  readonly status: string;
  readonly deleted_at?: number | null;
}

async function mediaTableHasDeletedAtColumn(tenantDb: D1Database): Promise<boolean> {
  try {
    const pragma = await tenantDb
      .prepare("PRAGMA table_info(media_items)")
      .all<{ readonly name: string }>();
    return pragma.results.some((col) => col.name === "deleted_at");
  } catch {
    return false;
  }
}

/**
 * Verifies EVERY referenced `mediaId` exists inside THIS tenant's own `TenantStore.media_items`
 * with `status = 'ready'`, not trashed, and matching expected media kind (`image` / `video`).
 *
 * Any missing, foreign (cross-tenant), trashed, quarantined, failed, or mismatched-kind media ID
 * is rejected with `422 PreviewValidationError` (`MEDIA_NOT_FOUND`).
 */
export async function verifyOwnedPreviewMediaIds(
  tenantDb: D1Database,
  refs: readonly PreviewMediaReference[],
): Promise<Map<number, ResolvedPreviewMedia>> {
  const verified = new Map<number, ResolvedPreviewMedia>();
  if (refs.length === 0) {
    return verified;
  }

  const uniqueIds = Array.from(new Set(refs.map((r) => r.mediaId)));
  const placeholders = uniqueIds.map(() => "?").join(", ");
  const hasDeletedAt = await mediaTableHasDeletedAtColumn(tenantDb);
  const selectCols = hasDeletedAt
    ? "id, kind, r2_key, alt_text, width, height, status, deleted_at"
    : "id, kind, r2_key, alt_text, width, height, status";

  const rows = await tenantDb
    .prepare(`SELECT ${selectCols} FROM media_items WHERE id IN (${placeholders})`)
    .bind(...uniqueIds)
    .all<RawMediaOwnershipRow>();

  const byId = new Map<number, RawMediaOwnershipRow>();
  for (const row of rows.results) {
    byId.set(Number(row.id), row);
  }

  const violations: Array<{ readonly field: string; readonly code: string; readonly message: string }> =
    [];

  for (const ref of refs) {
    const row = byId.get(ref.mediaId);
    const isTrashed = hasDeletedAt && row?.deleted_at !== null && row?.deleted_at !== undefined;
    const isReady = row?.status === "ready" && !isTrashed;
    const kindMatches = !ref.expectedKind || row?.kind === ref.expectedKind;

    if (!row || !isReady || !kindMatches) {
      violations.push({
        field: ref.field,
        code: "MEDIA_NOT_FOUND",
        message: `Media #${ref.mediaId} tidak ditemukan atau tidak dimiliki oleh tenant ini.`,
      });
      continue;
    }

    verified.set(ref.mediaId, {
      id: Number(row.id),
      kind: row.kind,
      r2Key: row.r2_key,
      altText: row.alt_text,
      width: row.width,
      height: row.height,
    });
  }

  if (violations.length > 0) {
    throw new PreviewValidationError(
      "Referensi media tidak valid atau bukan milik situs ini.",
      violations,
    );
  }

  return verified;
}

async function resolveHomepagePageId(tenantDb: D1Database): Promise<number | null> {
  const row = await tenantDb
    .prepare("SELECT id FROM pages WHERE is_homepage = 1 AND deleted_at IS NULL LIMIT 1")
    .first<{ readonly id: number }>();
  return row && typeof row.id === "number" ? row.id : null;
}

function renderPageSectionsBodyHtml(page: PageSnapshot | null, fallbackTitle: string): string {
  if (!page) {
    return `<section class="ps-container" style="padding: 2.5rem 0;">
      <h1>${escapeHtml(fallbackTitle)}</h1>
      <p>Belum ada konten draf halaman yang ditambahkan.</p>
    </section>`;
  }

  if (page.sections.length === 0) {
    return `<section class="ps-container" data-preview-resource="page" style="padding: 2.5rem 0;">
      <h1>${escapeHtml(page.title)}</h1>
      <p style="color: var(--ps-ink-muted);">Halaman ini belum memiliki bagian konten pada draf saat ini.</p>
    </section>`;
  }

  const renderedSections = page.sections
    .map((section) => {
      const headingHtml = section.heading
        ? section.kind === "hero"
          ? `<h1>${escapeHtml(section.heading)}</h1>`
          : `<h2>${escapeHtml(section.heading)}</h2>`
        : "";
      const subheadingHtml = section.subheading
        ? `<p style="color: var(--ps-ink-muted); max-width: 60ch;">${escapeHtml(section.subheading)}</p>`
        : "";
      const bodyFragment = section.bodyHtml
        ? `<div class="ps-preview-section-body">${sanitizePublishedHtmlFragment(section.bodyHtml)}</div>`
        : "";
      const ctaHtml =
        section.ctaLabel && section.ctaHref
          ? `<p style="margin-top: 1.25rem;"><a href="${escapeHtml(section.ctaHref)}" style="display: inline-flex; align-items: center; min-height: 44px; padding: 0.625rem 1.25rem; border-radius: var(--ps-radius); background: var(--ps-brand-primary); color: var(--ps-brand-on-primary); font-weight: 600; text-decoration: none;">${escapeHtml(section.ctaLabel)}</a></p>`
          : "";

      const bgStyle =
        section.kind === "hero"
          ? "background: var(--ps-surface-muted); border-bottom: 1px solid var(--ps-border);"
          : "";

      return `<section data-section-id="${escapeHtml(section.id)}" data-section-kind="${escapeHtml(section.kind)}" style="padding: clamp(2rem, 5vw, 3.5rem) 0; ${bgStyle}">
        <div class="ps-container">
          ${headingHtml}
          ${subheadingHtml}
          ${bodyFragment}
          ${ctaHtml}
        </div>
      </section>`;
    })
    .join("\n");

  return `<div data-preview-resource="page" data-page-slug="${escapeHtml(page.slug)}">${renderedSections}</div>`;
}

function renderPostBodyHtml(
  post: PostSnapshot,
  verifiedMedia: ReadonlyMap<number, ResolvedPreviewMedia>,
): string {
  const blocksHtml = post.body.blocks
    .map((block) => {
      if (block.type === "heading") {
        const level = block.level ?? 2;
        const tag = level === 3 ? "h3" : level === 4 ? "h4" : "h2";
        return `<${tag}>${escapeHtml(block.text ?? "")}</${tag}>`;
      }
      if (block.type === "blockquote") {
        return `<blockquote style="border-left: 3px solid var(--ps-brand-primary); padding-left: 1rem; margin: 1rem 0; color: var(--ps-ink-muted);">${escapeHtml(block.text ?? "")}</blockquote>`;
      }
      if (block.type === "listItem") {
        return `<p style="margin: 0.25rem 0 0.25rem 1rem;">&bull; ${escapeHtml(block.text ?? "")}</p>`;
      }
      if (block.type === "image" && block.mediaId !== undefined) {
        const media = verifiedMedia.get(block.mediaId);
        const alt = media?.altText || "Gambar artikel";
        return `<figure style="margin: 1.25rem 0; padding: 1rem; border: 1px solid var(--ps-border); border-radius: var(--ps-radius); background: var(--ps-surface-muted);">
          <figcaption style="font-size: 0.875rem; color: var(--ps-ink-muted);">Media terverifikasi #${block.mediaId}: ${escapeHtml(alt)}</figcaption>
        </figure>`;
      }
      const text = block.text ?? "";
      if (!text.trim()) return "";
      if (block.href) {
        return `<p><a href="${escapeHtml(block.href)}">${escapeHtml(text)}</a></p>`;
      }
      return `<p>${escapeHtml(text)}</p>`;
    })
    .filter(Boolean)
    .join("\n");

  const excerptHtml = post.excerpt
    ? `<p style="font-size: 1.0625rem; color: var(--ps-ink-muted); margin-bottom: 1.5rem;">${escapeHtml(post.excerpt)}</p>`
    : "";

  return `<article class="ps-container" data-preview-resource="post" data-post-slug="${escapeHtml(post.slug)}" style="padding: clamp(2rem, 4vw, 3rem) 0; max-width: 48rem;">
    <p style="font-size: 0.8125rem; color: var(--ps-brand-primary); font-weight: 600; margin-bottom: 0.5rem;">
      Artikel Draf &bull; Estimasi baca ${post.readingTimeMinutes} menit
    </p>
    <h1>${escapeHtml(post.title)}</h1>
    ${excerptHtml}
    <div class="ps-preview-article-body">${blocksHtml || "<p>Belum ada isi artikel.</p>"}</div>
  </article>`;
}

function renderOfferingBodyHtml(
  offering: OfferingSnapshot,
  verifiedMedia: ReadonlyMap<number, ResolvedPreviewMedia>,
): string {
  let priceLabel = "Hubungi untuk penawaran";
  if (offering.priceMode === "fixed" && typeof offering.price === "number") {
    priceLabel = formatIdr(offering.price);
  } else if (offering.priceMode === "from" && typeof offering.price === "number") {
    priceLabel = `Mulai ${formatIdr(offering.price)}`;
  } else if (
    offering.priceMode === "range" &&
    typeof offering.price === "number" &&
    typeof offering.priceMax === "number"
  ) {
    priceLabel = `${formatIdr(offering.price)} – ${formatIdr(offering.priceMax)}`;
  }

  const badgeHtml = offering.badge
    ? `<span style="display: inline-block; padding: 0.25rem 0.625rem; border-radius: 4px; background: var(--ps-surface-muted); border: 1px solid var(--ps-border); font-size: 0.75rem; font-weight: 600; margin-bottom: 0.75rem;">${escapeHtml(offering.badge)}</span>`
    : "";

  const summaryHtml = offering.summary
    ? `<p style="color: var(--ps-ink-muted); max-width: 60ch;">${escapeHtml(offering.summary)}</p>`
    : "";

  const descriptionHtml =
    typeof offering.description === "string"
      ? `<div>${sanitizePublishedHtmlFragment(offering.description)}</div>`
      : offering.description && typeof offering.description === "object"
        ? `<div>${offering.description.blocks
            .map((b) => (b.text ? `<p>${escapeHtml(b.text)}</p>` : ""))
            .join("")}</div>`
        : "";

  const coverMeta =
    offering.coverMediaId !== null && offering.coverMediaId !== undefined
      ? verifiedMedia.get(offering.coverMediaId)
      : undefined;
  const mediaNote = coverMeta
    ? `<p style="font-size: 0.8125rem; color: var(--ps-ink-muted);">Media utama terverifikasi #${coverMeta.id} (${escapeHtml(coverMeta.altText || "Foto penawaran")})</p>`
    : "";

  const ctaHref = offering.ctaMode === "external_link" && offering.externalUrl ? offering.externalUrl : "#kontak";
  const ctaLabel =
    offering.ctaMode === "whatsapp"
      ? "Hubungi via WhatsApp"
      : offering.ctaMode === "book"
        ? "Ajukan Pemesanan"
        : offering.ctaMode === "external_link"
          ? "Buka Tautan Resmi"
          : "Minta Penawaran";

  return `<section class="ps-container" data-preview-resource="offering" data-offering-type="${escapeHtml(offering.offeringType)}" style="padding: clamp(2rem, 4vw, 3rem) 0;">
    ${badgeHtml}
    <h1>${escapeHtml(offering.title)}</h1>
    <p class="ps-tabular" style="font-size: 1.25rem; font-weight: 700; color: var(--ps-brand-primary); margin: 0.5rem 0 1rem;">
      ${escapeHtml(priceLabel)}${offering.negotiable ? " (Nego)" : ""}
    </p>
    ${summaryHtml}
    ${mediaNote}
    ${descriptionHtml}
    <p style="margin-top: 1.5rem;">
      <a href="${escapeHtml(ctaHref)}" style="display: inline-flex; align-items: center; min-height: 44px; padding: 0.625rem 1.25rem; border-radius: var(--ps-radius); background: var(--ps-brand-primary); color: var(--ps-brand-on-primary); font-weight: 600; text-decoration: none;">${escapeHtml(ctaLabel)}</a>
    </p>
  </section>`;
}

function renderThemeOrIdentityBodyHtml(
  kind: "theme" | "identity" | "menu",
  shell: TenantShellData,
): string {
  const title =
    kind === "theme"
      ? `Pratinjau Tema ${shell.themeId}`
      : kind === "identity"
        ? `Identitas Situs — ${shell.business.name}`
        : `Pratinjau Navigasi — ${shell.site.title}`;

  return `<section data-preview-resource="${kind}" style="padding: clamp(2rem, 5vw, 3.5rem) 0; background: var(--ps-surface-muted); border-bottom: 1px solid var(--ps-border);">
    <div class="ps-container">
      <p style="margin: 0 0 0.5rem; font-size: 0.875rem; font-weight: 700; color: var(--ps-brand-primary); text-transform: uppercase;">
        ${escapeHtml(shell.site.tagline || shell.business.category)}
      </p>
      <h1>${escapeHtml(title)}</h1>
      <p style="max-width: 60ch; color: var(--ps-ink-muted);">
        ${escapeHtml(shell.business.description || "Pratinjau draf menggunakan komponen tema Astro yang sama dengan situs publik.")}
      </p>
      <div style="display: flex; flex-wrap: wrap; gap: 0.75rem; margin-top: 1.25rem;">
        <a href="/kontak" style="display: inline-flex; align-items: center; min-height: 44px; padding: 0.625rem 1.25rem; border-radius: var(--ps-radius); background: var(--ps-brand-primary); color: var(--ps-brand-on-primary); font-weight: 600; text-decoration: none;">
          Tombol Utama
        </a>
        <a href="https://example.com" style="display: inline-flex; align-items: center; min-height: 44px; padding: 0.625rem 1.25rem; border-radius: var(--ps-radius); background: var(--ps-surface); color: var(--ps-ink); border: 1px solid var(--ps-border); font-weight: 600; text-decoration: none;">
          Tombol Sekunder
        </a>
      </div>
    </div>
  </section>`;
}

/**
 * Loads the authorized tenant's draft data, enforces optimistic version checks,
 * validates theme registration and tenant media ownership, and builds a complete
 * `PreviewRenderModel` backed by `loadPublishedTenantShellData(..., { previewMode: true })`.
 */
export async function loadTenantDraftPreviewData(
  params: LoadTenantDraftPreviewParams,
): Promise<PreviewRenderModel> {
  const { platformDb, tenantDb, tenantId, tenantName, input } = params;
  const override = input.draftOverride;

  let resolvedVersion = 0;
  let resolvedResourceId: number | string | null = input.resourceId ?? null;
  let hasUnpublishedChanges = Boolean(override);

  let draftPage: PageSnapshot | null = null;
  let draftPost: PostSnapshot | null = null;
  let draftOffering: OfferingSnapshot | null = null;
  let draftSiteSettings: SiteSettingsSnapshot | null = override?.siteSettings ?? null;
  let draftBusinessProfile: BusinessProfileSnapshot | null = override?.businessProfile ?? null;
  let draftThemeConfig: ThemeConfigSnapshot | null = override?.themeConfig ?? null;
  let draftMenus: PreviewShellDraftOverride["menus"] | undefined = override?.menus;

  const assertExpectedVersion = (
    resourceType:
      | "page"
      | "post"
      | "offering"
      | "site_settings"
      | "business_profile"
      | "theme_config"
      | "menu",
    resourceId: number | string,
    actualVersion: number,
  ) => {
    if (input.expectedVersion !== undefined && actualVersion !== input.expectedVersion) {
      throw new StaleRevisionError({
        resourceType,
        resourceId,
        expectedVersion: input.expectedVersion,
        actualVersion,
      });
    }
  };

  switch (input.resourceKind) {
    case "home":
    case "page": {
      const targetPageId =
        input.resourceId ??
        (input.resourceKind === "home" ? await resolveHomepagePageId(tenantDb) : null);

      if (targetPageId !== null) {
        const dto = await getDraftResourceForAdmin(tenantDb, {
          resourceType: "page",
          resourceId: targetPageId,
        });
        if (!dto) {
          throw new PublicationNotFoundError("page", targetPageId);
        }
        assertExpectedVersion("page", targetPageId, dto.version);
        resolvedVersion = dto.version;
        resolvedResourceId = targetPageId;
        draftPage = override?.page ?? dto.draft ?? dto.published;
        hasUnpublishedChanges = hasUnpublishedChanges || dto.hasUnpublishedChanges;
      } else if (override?.page) {
        draftPage = override.page;
        resolvedResourceId = "home";
        resolvedVersion = input.expectedVersion ?? 0;
      } else if (input.resourceKind === "page") {
        throw new PublicationNotFoundError("page", input.resourceId ?? 0);
      } else {
        // Empty homepage draft before any page row exists
        if (input.expectedVersion !== undefined && input.expectedVersion !== 0) {
          throw new StaleRevisionError({
            resourceType: "page",
            resourceId: "home",
            expectedVersion: input.expectedVersion,
            actualVersion: 0,
          });
        }
        resolvedResourceId = "home";
        resolvedVersion = 0;
      }
      break;
    }

    case "post": {
      if (input.resourceId !== undefined) {
        const dto = await getDraftResourceForAdmin(tenantDb, {
          resourceType: "post",
          resourceId: input.resourceId,
        });
        if (!dto) {
          throw new PublicationNotFoundError("post", input.resourceId);
        }
        assertExpectedVersion("post", input.resourceId, dto.version);
        resolvedVersion = dto.version;
        resolvedResourceId = input.resourceId;
        draftPost = override?.post ?? dto.draft ?? dto.published;
        hasUnpublishedChanges = hasUnpublishedChanges || dto.hasUnpublishedChanges;
      } else if (override?.post) {
        draftPost = override.post;
        resolvedResourceId = null;
        resolvedVersion = input.expectedVersion ?? 0;
      } else {
        throw new PublicationNotFoundError("post", 0);
      }
      break;
    }

    case "offering": {
      if (input.resourceId !== undefined) {
        const dto = await getDraftResourceForAdmin(tenantDb, {
          resourceType: "offering",
          resourceId: input.resourceId,
        });
        if (!dto) {
          throw new PublicationNotFoundError("offering", input.resourceId);
        }
        assertExpectedVersion("offering", input.resourceId, dto.version);
        resolvedVersion = dto.version;
        resolvedResourceId = input.resourceId;
        draftOffering = override?.offering ?? dto.draft ?? dto.published;
        hasUnpublishedChanges = hasUnpublishedChanges || dto.hasUnpublishedChanges;
      } else if (override?.offering) {
        draftOffering = override.offering;
        resolvedResourceId = null;
        resolvedVersion = input.expectedVersion ?? 0;
      } else {
        throw new PublicationNotFoundError("offering", 0);
      }
      break;
    }

    case "identity": {
      const [settingsDto, profileDto] = await Promise.all([
        getDraftResourceForAdmin(tenantDb, { resourceType: "site_settings" }),
        getDraftResourceForAdmin(tenantDb, { resourceType: "business_profile" }),
      ]);
      const combinedVersion = Math.max(settingsDto?.version ?? 0, profileDto?.version ?? 0);
      assertExpectedVersion("site_settings", 1, combinedVersion);
      resolvedVersion = combinedVersion;
      resolvedResourceId = 1;
      draftSiteSettings =
        override?.siteSettings ?? settingsDto?.draft ?? settingsDto?.published ?? null;
      draftBusinessProfile =
        override?.businessProfile ?? profileDto?.draft ?? profileDto?.published ?? null;
      hasUnpublishedChanges =
        hasUnpublishedChanges ||
        Boolean(settingsDto?.hasUnpublishedChanges || profileDto?.hasUnpublishedChanges);
      break;
    }

    case "theme": {
      const settingsDto = await getDraftResourceForAdmin(tenantDb, {
        resourceType: "site_settings",
      });
      const targetThemeId =
        input.themeId ??
        override?.themeConfig?.themeId ??
        settingsDto?.draft?.activeThemeId ??
        settingsDto?.published?.activeThemeId ??
        "compro";
      await verifyPreviewThemeRegistered(platformDb, tenantId, targetThemeId);

      const themeDto = await getDraftResourceForAdmin(tenantDb, {
        resourceType: "theme_config",
        resourceId: targetThemeId,
      });
      const currentVersion = themeDto?.version ?? 0;
      assertExpectedVersion("theme_config", targetThemeId, currentVersion);
      resolvedVersion = currentVersion;
      resolvedResourceId = targetThemeId;
      draftThemeConfig = override?.themeConfig ?? themeDto?.draft ?? themeDto?.published ?? null;
      hasUnpublishedChanges = hasUnpublishedChanges || Boolean(themeDto?.hasUnpublishedChanges);
      break;
    }

    case "menu": {
      const loc = input.menuLocation ?? override?.menu?.location ?? "header";
      const menuDto = await getDraftResourceForAdmin(tenantDb, {
        resourceType: "menu",
        location: loc,
      });
      const currentVersion = menuDto?.version ?? 0;
      assertExpectedVersion("menu", loc, currentVersion);
      resolvedVersion = currentVersion;
      resolvedResourceId = menuDto?.resourceId ?? loc;
      const effectiveMenu = override?.menu ?? menuDto?.draft ?? menuDto?.published ?? null;
      if (effectiveMenu) {
        draftMenus = {
          ...draftMenus,
          [loc]: effectiveMenu,
        };
      }
      hasUnpublishedChanges = hasUnpublishedChanges || Boolean(menuDto?.hasUnpublishedChanges);
      break;
    }
  }

  // Validate explicitly requested themeId (if provided for any resourceKind)
  const requestedThemeId =
    input.themeId ?? draftThemeConfig?.themeId ?? draftSiteSettings?.activeThemeId;
  if (requestedThemeId) {
    await verifyPreviewThemeRegistered(platformDb, tenantId, requestedThemeId);
  }

  // Verify EVERY referenced media ID belongs to THIS tenant in its own TenantStore!
  const mediaRefs = extractReferencedMediaIds({
    page: draftPage,
    post: draftPost,
    offering: draftOffering,
    siteSettings: draftSiteSettings,
    extraMediaIds: override?.mediaIds,
  });
  const verifiedMedia = await verifyOwnedPreviewMediaIds(tenantDb, mediaRefs);

  // Build bounded previewDraftOverride for the shared TASK-012 shell loader
  const previewDraftOverride: PreviewShellDraftOverride = {
    ...(draftSiteSettings ? { siteSettings: draftSiteSettings } : {}),
    ...(draftBusinessProfile ? { businessProfile: draftBusinessProfile } : {}),
    ...(draftThemeConfig ? { themeConfig: draftThemeConfig } : {}),
    ...(draftPage ? { page: draftPage } : {}),
    ...(draftMenus ? { menus: draftMenus } : {}),
    ...(input.layoutMode ?? override?.layoutMode
      ? { layoutMode: input.layoutMode ?? override?.layoutMode }
      : {}),
  };

  // Load tenant shell through the EXACT shared TASK-012 loader in explicit previewMode
  const shell = await loadPublishedTenantShellData(tenantDb, {
    previewMode: true,
    previewDraftOverride,
    themeIdOverride: requestedThemeId,
    layoutModeOverride: input.layoutMode ?? override?.layoutMode ?? draftPage?.layoutMode,
    pageSlug: draftPage?.slug,
    fallbackSiteTitle: tenantName,
    fallbackBusinessName: tenantName,
  });

  // Render body HTML for the requested resource
  let bodyHtml: string;
  let pageTitle: string;
  let pageDescription: string | null = shell.site.tagline ?? shell.business.description ?? null;
  let currentPath = "/";

  if (input.resourceKind === "post" && draftPost) {
    bodyHtml = renderPostBodyHtml(draftPost, verifiedMedia);
    pageTitle = draftPost.title;
    pageDescription = draftPost.excerpt ?? pageDescription;
    currentPath = `/blog/${draftPost.slug}`;
  } else if (input.resourceKind === "offering" && draftOffering) {
    bodyHtml = renderOfferingBodyHtml(draftOffering, verifiedMedia);
    pageTitle = draftOffering.title;
    pageDescription = draftOffering.summary ?? pageDescription;
    currentPath = `/${draftOffering.offeringType}/${draftOffering.slug}`;
  } else if (
    input.resourceKind === "theme" ||
    input.resourceKind === "identity" ||
    input.resourceKind === "menu"
  ) {
    bodyHtml = renderThemeOrIdentityBodyHtml(input.resourceKind, shell);
    pageTitle =
      input.resourceKind === "theme"
        ? `Pratinjau Tema ${shell.themeId}`
        : input.resourceKind === "identity"
          ? shell.site.title
          : `Navigasi — ${shell.site.title}`;
  } else {
    bodyHtml = renderPageSectionsBodyHtml(draftPage, shell.site.title);
    pageTitle = draftPage?.title ?? shell.site.title;
    currentPath = draftPage && !draftPage.isHomepage ? `/${draftPage.slug}` : "/";
  }

  return {
    shell,
    resourceKind: input.resourceKind,
    resourceId: resolvedResourceId,
    version: resolvedVersion,
    themeId: shell.themeId,
    layoutMode: shell.layoutMode,
    pageTitle,
    pageDescription,
    currentPath,
    bodyHtml,
    logoUrl: null,
    hasUnpublishedChanges,
    verifiedMedia,
  };
}

/**
 * Renders the resolved preview model through the provided in-process Astro shell renderer,
 * neutralizes scripts/forms/external navigation, and enforces `MAX_PREVIEW_HTML_BYTES`.
 */
export async function renderTenantDraftPreview(
  params: LoadTenantDraftPreviewParams,
  renderShellDocument: RenderPreviewShellDocumentFn,
): Promise<RenderTenantDraftPreviewResult> {
  const model = await loadTenantDraftPreviewData(params);
  const rawHtml = await renderShellDocument(model);
  const inertHtml = neutralizePreviewHtml(rawHtml);

  const htmlBytes = new TextEncoder().encode(inertHtml).byteLength;
  if (htmlBytes > MAX_PREVIEW_HTML_BYTES) {
    throw new PreviewPayloadTooLargeError(htmlBytes, MAX_PREVIEW_HTML_BYTES);
  }

  return {
    html: inertHtml,
    model,
  };
}

/**
 * Lightweight deterministic HTML renderer matching `Layout.astro`'s structure for
 * non-Astro test harnesses (e.g. `workerd` Vitest integration tests without Astro Vite plugin).
 * Production Astro endpoints ALWAYS pass the real `experimental_AstroContainer` renderer
 * (`apps/web/src/core/preview/astro-renderer.ts`) rendering `apps/web/src/themes/default/Layout.astro`.
 */
export function renderSemanticPreviewShellFallback(model: PreviewRenderModel): string {
  const { shell } = model;
  const isFocused = model.layoutMode === "focused";
  const lang = shell.site.locale.split("-")[0]?.toLowerCase() || "id";
  const headerLinks = shell.menus.header
    .map((item) => `<li><a href="${escapeHtml(item.href)}">${escapeHtml(item.label)}</a></li>`)
    .join("");
  const footerLinks = shell.menus.footer
    .map((item) => `<li><a href="${escapeHtml(item.href)}">${escapeHtml(item.label)}</a></li>`)
    .join("");

  return `<!doctype html>
<html lang="${escapeHtml(lang)}" data-ps-theme="${escapeHtml(shell.baseThemeId)}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(model.pageTitle)} — ${escapeHtml(shell.site.title)}</title>
    <meta name="robots" content="noindex, nofollow" />
    <style>${shell.themeStyle.css}</style>
  </head>
  <body data-ps-theme="${escapeHtml(shell.baseThemeId)}" data-layout-mode="${escapeHtml(model.layoutMode)}" data-preview="true">
    <a class="ps-skip-link" href="#main-content">Lewati ke konten utama</a>
    <div class="ps-preview-bar" role="status" data-testid="preview-mode-banner">Mode Pratinjau Draf — Perubahan belum diterbitkan ke pengunjung publik.</div>
    ${
      !isFocused
        ? `<header class="ps-header" data-testid="site-header"><div class="ps-container ps-header-inner"><a href="/" class="ps-brand">${escapeHtml(shell.business.name)}</a><nav aria-label="Navigasi utama"><ul>${headerLinks}</ul></nav></div></header>`
        : ""
    }
    <main id="main-content" class="ps-main" tabindex="-1">${model.bodyHtml}</main>
    ${
      !isFocused
        ? `<footer class="ps-footer" data-testid="site-footer"><div class="ps-container"><p>${escapeHtml(shell.business.name)}</p><nav aria-label="Navigasi footer"><ul>${footerLinks}</ul></nav></div></footer>`
        : ""
    }
  </body>
</html>`;
}

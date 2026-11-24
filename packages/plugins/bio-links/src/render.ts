import type { PluginTenantSnapshot } from "@punyasitus/core/plugins/index";
import { buildWhatsAppUrl, validateIndonesianWhatsAppNumber } from "@punyasitus/core/wa-dispatcher";
import type { BioLinkItemRecord, BioLinkProfileRecord } from "./service.ts";
import { BIO_LINKS_DEFAULT_ACCENT, escapeHtml, validateBioLinkUrl } from "./validation.ts";

/**
 * Pure ZERO-JS semantic HTML + CSS renderer for `/link` and `/link/go` (`REQ-099`, `TASK-099`).
 *
 * Hard invariants:
 * - Emits literally ZERO `<script>` tags and ZERO inline event handlers (`jsBytes: 0`).
 * - Escapes every dynamic string and re-validates every URL at render time.
 * - Mobile-first (360px -> 1440px), zero horizontal overflow, >= 48px touch targets.
 */

function computeInitials(name: string): string {
  const words = name
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0);
  if (words.length === 0) return "PS";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return `${words[0]![0] ?? ""}${words[1]![0] ?? ""}`.toUpperCase();
}

function resolveSafeAccent(accent: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(accent) ? accent.toUpperCase() : BIO_LINKS_DEFAULT_ACCENT;
}

export interface RenderBioLinksPageInput {
  readonly tenant: PluginTenantSnapshot;
  readonly profile: BioLinkProfileRecord;
  readonly items: readonly BioLinkItemRecord[];
  readonly clickPathPrefix?: string;
}

export interface RenderedBioLinksHtml {
  readonly html: string;
  readonly cssBytes: number;
  readonly jsBytes: 0;
  readonly title: string;
  readonly description: string;
}

const BIO_LINKS_CSS = `
*,*::before,*::after{box-sizing:border-box}
body{margin:0;background:var(--bio-bg,#f8fafc);color:var(--bio-fg,#0f172a);font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;line-height:1.5;-webkit-font-smoothing:antialiased}
.bio-shell{min-height:100vh;padding:28px 16px 40px;display:flex;flex-direction:column;align-items:center;justify-content:flex-start}
.bio-card{width:100%;max-width:460px;background:#ffffff;border:1px solid #e2e8f0;border-radius:16px;padding:28px 20px;box-shadow:0 1px 3px rgba(15,23,42,.06)}
.bio-header{display:flex;flex-direction:column;align-items:center;text-align:center;gap:12px;margin-bottom:24px}
.bio-avatar{width:76px;height:76px;border-radius:9999px;object-fit:cover;border:2px solid var(--bio-accent,#0F766E);background:#f1f5f9}
.bio-monogram{width:76px;height:76px;border-radius:9999px;display:inline-flex;align-items:center;justify-content:center;font-size:24px;font-weight:700;letter-spacing:.02em;color:#ffffff;background:var(--bio-accent,#0F766E)}
.bio-name{margin:0;font-size:22px;font-weight:700;letter-spacing:-.02em;color:#0f172a;word-break:break-word}
.bio-headline{margin:0;font-size:14px;font-weight:500;color:var(--bio-accent,#0F766E);word-break:break-word}
.bio-desc{margin:0;font-size:14px;color:#475569;max-width:38ch;word-break:break-word}
.bio-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:12px}
.bio-link{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:54px;padding:13px 16px;border-radius:12px;border:1px solid #cbd5e1;background:#ffffff;color:#0f172a;text-decoration:none;transition:border-color .15s ease,background-color .15s ease}
.bio-link:hover,.bio-link:focus-visible{border-color:var(--bio-accent,#0F766E);background:#f8fafc;outline:2px solid var(--bio-accent,#0F766E);outline-offset:2px}
.bio-link-body{min-width:0;display:flex;flex-direction:column;gap:2px;flex:1}
.bio-link-top{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.bio-link-label{font-size:15px;font-weight:600;color:#0f172a;word-break:break-word}
.bio-link-badge{display:inline-flex;align-items:center;padding:2px 8px;border-radius:9999px;font-size:11px;font-weight:600;background:#f1f5f9;color:#334155;border:1px solid #e2e8f0}
.bio-link-sub{font-size:12px;color:#64748b;word-break:break-word}
.bio-arrow{flex-shrink:0;color:#64748b;font-size:16px;font-weight:600}
.bio-wa-wrap{margin-top:18px;padding-top:18px;border-top:1px solid #e2e8f0}
.bio-wa-btn{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;min-height:48px;padding:12px 16px;border-radius:12px;background:var(--bio-accent,#0F766E);color:#ffffff;font-size:15px;font-weight:600;text-decoration:none}
.bio-wa-btn:hover,.bio-wa-btn:focus-visible{opacity:.92;outline:2px solid #0f172a;outline-offset:2px}
.bio-empty{margin:0;padding:18px;text-align:center;border-radius:12px;border:1px dashed #cbd5e1;color:#64748b;font-size:14px}
.bio-footer{margin-top:20px;text-align:center;font-size:12px;color:#64748b}
.bio-footer a{color:#475569;text-decoration:underline;text-underline-offset:3px}
`.trim();

const BIO_LINKS_CSS_BYTES = new TextEncoder().encode(BIO_LINKS_CSS).byteLength;

export function renderBioLinksPublicHtml(input: RenderBioLinksPageInput): RenderedBioLinksHtml {
  const displayName = input.profile.displayName.trim() || input.tenant.name;
  const headline = input.profile.headline.trim();
  const bioText = input.profile.bioText.trim();
  const accent = resolveSafeAccent(input.profile.themeAccent);
  const clickPrefix = input.clickPathPrefix ?? "/link/go";

  // Safe avatar rendering (strictly https/http or relative path without backslashes)
  let avatarHtml = `<span class="bio-monogram" aria-hidden="true">${escapeHtml(computeInitials(displayName))}</span>`;
  if (input.profile.avatarUrl.trim().length > 0) {
    const rawAvatar = input.profile.avatarUrl.trim();
    const hasBackslash = rawAvatar.includes("\\");
    const isSafeRelative =
      !hasBackslash && rawAvatar.startsWith("/") && !rawAvatar.startsWith("//");
    const checkedAvatar = hasBackslash
      ? { ok: false as const, reason: "Invalid backslash" }
      : isSafeRelative
        ? { ok: true as const, url: rawAvatar }
        : validateBioLinkUrl(rawAvatar);
    if (
      checkedAvatar.ok &&
      (isSafeRelative ||
        checkedAvatar.url.startsWith("https://") ||
        checkedAvatar.url.startsWith("http://"))
    ) {
      avatarHtml = `<img class="bio-avatar" src="${escapeHtml(checkedAvatar.url)}" alt="Foto profil ${escapeHtml(displayName)}" width="76" height="76" loading="lazy" decoding="async" />`;
    }
  }

  // Render ONLY active items whose stored URL passes strict allowlist check
  const safeItems = input.items.filter((item) => item.isActive && validateBioLinkUrl(item.url).ok);
  const listHtml =
    safeItems.length === 0
      ? `<p class="bio-empty" data-testid="bio-links-empty">Belum ada tautan aktif untuk ditampilkan.</p>`
      : `<nav aria-label="Daftar tautan utama"><ul class="bio-list" data-testid="bio-links-list">${safeItems
          .map((item) => {
            const href = `${clickPrefix}?id=${encodeURIComponent(item.id)}`;
            const badgeHtml = item.badge
              ? `<span class="bio-link-badge">${escapeHtml(item.badge)}</span>`
              : "";
            const subtitleHtml = item.subtitle
              ? `<span class="bio-link-sub">${escapeHtml(item.subtitle)}</span>`
              : "";
            return `<li><a class="bio-link" data-testid="bio-link-item" data-link-id="${escapeHtml(item.id)}" href="${escapeHtml(href)}"><span class="bio-link-body"><span class="bio-link-top"><span class="bio-link-label">${escapeHtml(item.label)}</span>${badgeHtml}</span>${subtitleHtml}</span><span class="bio-arrow" aria-hidden="true">&#8594;</span></a></li>`;
          })
          .join("")}</ul></nav>`;

  // Optional WhatsApp CTA button (pure HTML anchor, 0 JS)
  let whatsappHtml = "";
  if (input.profile.showWhatsappButton && input.profile.whatsappPhone.trim().length > 0) {
    const phoneCheck = validateIndonesianWhatsAppNumber(input.profile.whatsappPhone);
    if (phoneCheck.ok) {
      const template =
        input.profile.whatsappMessage.trim().length > 0
          ? input.profile.whatsappMessage.trim()
          : `Halo ${displayName}, saya menemukan halaman tautan Anda.`;
      const waDispatch = buildWhatsAppUrl({
        tenantPhone: phoneCheck.phone,
        template: "{{item_title}}",
        itemTitle: template,
        pageUrl: input.tenant.primaryHost
          ? `https://${input.tenant.primaryHost}/link`
          : `https://${input.tenant.handle}.situsku.click/link`,
      });
      whatsappHtml = `<div class="bio-wa-wrap"><a class="bio-wa-btn" data-testid="bio-links-wa-cta" href="${escapeHtml(waDispatch.url)}" rel="noopener noreferrer">${escapeHtml(input.profile.whatsappLabel || "Hubungi via WhatsApp")}</a></div>`;
    }
  }

  const html = `<style>:root{--bio-accent:${accent}}${BIO_LINKS_CSS}</style><div class="bio-shell" data-testid="bio-links-page" data-tenant-handle="${escapeHtml(input.tenant.handle)}"><article class="bio-card"><header class="bio-header">${avatarHtml}<h1 class="bio-name">${escapeHtml(displayName)}</h1>${headline ? `<p class="bio-headline">${escapeHtml(headline)}</p>` : ""}${bioText ? `<p class="bio-desc">${escapeHtml(bioText)}</p>` : ""}</header>${listHtml}${whatsappHtml}<footer class="bio-footer"><a href="/">Kunjungi situs utama ${escapeHtml(input.tenant.name)}</a></footer></article></div>`;

  return {
    html,
    cssBytes: BIO_LINKS_CSS_BYTES,
    jsBytes: 0,
    title: displayName,
    description: headline || bioText || `Tautan resmi ${displayName}`,
  };
}

export function renderBioLinkGoHandoffHtml(input: {
  readonly label: string;
  readonly targetUrl: string;
  readonly tenantName: string;
}): { readonly html: string; readonly cssBytes: number; readonly jsBytes: 0 } {
  const safeTarget = validateBioLinkUrl(input.targetUrl);
  if (!safeTarget.ok) {
    return {
      html: `<div class="bio-shell"><article class="bio-card"><h1 class="bio-name">Tautan tidak tersedia</h1><p class="bio-desc">Tautan tujuan tidak memenuhi kebijakan keamanan.</p><div class="bio-wa-wrap"><a class="bio-wa-btn" href="/link">Kembali ke halaman tautan</a></div></article></div>`,
      cssBytes: BIO_LINKS_CSS_BYTES,
      jsBytes: 0,
    };
  }
  const html = `<style>${BIO_LINKS_CSS}</style><div class="bio-shell" data-testid="bio-link-go-page"><article class="bio-card"><header class="bio-header"><h1 class="bio-name">${escapeHtml(input.label)}</h1><p class="bio-desc">Klik tercatat untuk ${escapeHtml(input.tenantName)}. Lanjutkan membuka tautan tujuan di bawah ini.</p></header><a class="bio-wa-btn" data-testid="bio-link-go-continue" href="${escapeHtml(safeTarget.url)}" rel="noopener noreferrer">Lanjutkan ke tautan</a><footer class="bio-footer"><a href="/link">Kembali ke daftar tautan</a></footer></article></div>`;
  return {
    html,
    cssBytes: BIO_LINKS_CSS_BYTES,
    jsBytes: 0,
  };
}

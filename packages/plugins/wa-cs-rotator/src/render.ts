import type { PluginTenantSnapshot } from "@punyasitus/core/plugins/index";
import type { WaRotationExecutionResult } from "./service.ts";
import { escapeHtml } from "./validation.ts";

/**
 * Pure ZERO-JS HTML renderers for `wa-cs-rotator` public section & `/wa-rotator` route
 * (`REQ-099`, `REQ-040`, `TASK-099` — strictly `0` bytes client JS, well under `<= 25 KiB`).
 */

const ROTATOR_CSS = `
.wa-rot-card{max-width:440px;margin:32px auto;padding:24px 20px;border:1px solid #e2e8f0;border-radius:16px;background:#ffffff;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#0f172a;text-align:center}
.wa-rot-badge{display:inline-block;padding:4px 10px;border-radius:9999px;font-size:12px;font-weight:600;background:#ecfdf5;color:#047857;border:1px solid #a7f3d0;margin-bottom:12px}
.wa-rot-title{margin:0 0 8px;font-size:20px;font-weight:700}
.wa-rot-desc{margin:0 0 20px;font-size:14px;color:#475569}
.wa-rot-btn{display:inline-flex;align-items:center;justify-content:center;width:100%;min-height:48px;padding:12px 18px;border-radius:12px;background:#0f766e;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none}
.wa-rot-btn:hover,.wa-rot-btn:focus-visible{background:#115e59;outline:2px solid #0f172a;outline-offset:2px}
.wa-rot-back{display:inline-block;margin-top:16px;font-size:13px;color:#475569;text-decoration:underline}
`.trim();

const ROTATOR_CSS_BYTES = new TextEncoder().encode(ROTATOR_CSS).byteLength;

export function renderWaRotatorCtaSectionHtml(input: {
  readonly tenant: PluginTenantSnapshot;
  readonly ctaLabel: string;
  readonly onShiftCount: number;
  readonly href: string;
}): { readonly html: string; readonly cssBytes: number; readonly jsBytes: 0 } {
  const statusText =
    input.onShiftCount > 0
      ? `${input.onShiftCount} agen sales siap membantu sekarang`
      : `Hubungi layanan utama ${input.tenant.name}`;

  const html = `<section data-plugin-section="wa-cs-rotator-cta" data-on-shift="${input.onShiftCount}" style="padding:16px;border:1px solid #e2e8f0;border-radius:12px;background:#ffffff"><p style="margin:0 0 10px;font-size:13px;color:#475569">${escapeHtml(statusText)}</p><a href="${escapeHtml(input.href)}" rel="noopener noreferrer" style="display:inline-flex;align-items:center;justify-content:center;min-height:48px;padding:10px 18px;border-radius:10px;background:#0f766e;color:#ffffff;font-weight:600;text-decoration:none">${escapeHtml(input.ctaLabel)}</a></section>`;

  return {
    html,
    cssBytes: 180,
    jsBytes: 0,
  };
}

export function renderWaRotatorHandoffHtml(input: {
  readonly tenant: PluginTenantSnapshot;
  readonly result: WaRotationExecutionResult;
  readonly ctaLabel: string;
}): { readonly html: string; readonly cssBytes: number; readonly jsBytes: 0; readonly title: string } {
  const agentHeading = input.result.agent
    ? `Terhubung dengan ${input.result.agent.name} (${input.result.agent.roleLabel})`
    : `Terhubung dengan Layanan Utama ${input.tenant.name}`;
  const badge = input.result.usedFallback
    ? "Layanan Utama (Di Luar Jam Shift CS)"
    : "Agen Sales Sedang Bertugas";

  const html = `<style>${ROTATOR_CSS}</style><div class="wa-rot-card" data-testid="wa-rotator-handoff" data-mode="${escapeHtml(input.result.mode)}" data-agent-id="${escapeHtml(input.result.agent?.id ?? "")}"><span class="wa-rot-badge">${escapeHtml(badge)}</span><h1 class="wa-rot-title">${escapeHtml(agentHeading)}</h1><p class="wa-rot-desc">Klik tombol di bawah untuk membuka percakapan WhatsApp dengan pesan yang sudah disiapkan.</p><a class="wa-rot-btn" data-testid="wa-rotator-open-link" href="${escapeHtml(input.result.url)}" rel="noopener noreferrer">${escapeHtml(input.ctaLabel)}</a><a class="wa-rot-back" href="/">Kembali ke ${escapeHtml(input.tenant.name)}</a></div>`;

  return {
    html,
    cssBytes: ROTATOR_CSS_BYTES,
    jsBytes: 0,
    title: agentHeading,
  };
}

export function renderWaRotatorUnavailableHtml(input: {
  readonly tenant: PluginTenantSnapshot;
}): { readonly html: string; readonly cssBytes: number; readonly jsBytes: 0; readonly title: string } {
  const title = `Hubungi ${input.tenant.name}`;
  const html = `<style>${ROTATOR_CSS}</style><div class="wa-rot-card" data-testid="wa-rotator-unavailable"><span class="wa-rot-badge">Di Luar Jam Operasional</span><h1 class="wa-rot-title">Tim Sales Sedang Tidak Bertugas</h1><p class="wa-rot-desc">Saat ini seluruh agen WhatsApp sedang di luar jam aktif dan nomor cadangan belum diatur. Silakan kunjungi situs utama ${escapeHtml(input.tenant.name)} untuk meninggalkan pesan.</p><a class="wa-rot-btn" data-testid="wa-rotator-unavailable-home" href="/">Kembali ke Situs Utama</a></div>`;
  return {
    html,
    cssBytes: ROTATOR_CSS_BYTES,
    jsBytes: 0,
    title,
  };
}

import { experimental_AstroContainer } from "astro/container";
import PreviewThemeDocument from "./PreviewThemeDocument.astro";
import type { PreviewRenderModel } from "./service.ts";

/**
 * In-Process Astro Theme Renderer (PLAN §14, ADR-0007, TASK-050).
 *
 * Renders the EXACT SAME registered Astro theme shell (`apps/web/src/themes/default/Layout.astro`)
 * directly in-process via Astro's Container API — zero internal renderer endpoint,
 * zero separate rendering service, zero duplicated rendering engine.
 */
export async function renderPreviewDocumentInProcess(model: PreviewRenderModel): Promise<string> {
  const container = await experimental_AstroContainer.create();
  return container.renderToString(PreviewThemeDocument, {
    props: { model },
    partial: false,
  });
}

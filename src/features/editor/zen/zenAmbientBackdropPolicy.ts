import type { PanelId } from "@/features/layout/panelIds";

export interface ZenAmbientBackdropContext {
  panelWindowTarget: PanelId | null;
  screenshotPanelId: PanelId | null;
}

/** Every workspace window can expose Editor or tool-panel Glass surfaces. */
export function shouldMountZenAmbientBackdrop(
  _context: ZenAmbientBackdropContext,
): boolean {
  return true;
}

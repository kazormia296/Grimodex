import type { PanelId } from "@/features/layout/panelIds";

export interface ZenAmbientBackdropContext {
  panelWindowTarget: PanelId | null;
  screenshotPanelId: PanelId | null;
}

/** WebGL is useful only when this window actually renders the Editor surface. */
export function shouldMountZenAmbientBackdrop({
  panelWindowTarget,
  screenshotPanelId,
}: ZenAmbientBackdropContext): boolean {
  const soloPanelId = screenshotPanelId ?? panelWindowTarget;
  return soloPanelId === null || soloPanelId === "editor";
}

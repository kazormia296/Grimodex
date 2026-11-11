import type { PanelId } from "./panelIds";
import { PANEL_REGION_MAP, type PanelRegion } from "./panelRegions";

// パネルの矩形の測り方。強調の overlay（gsap を使う）を読まずに矩形だけ使えるよう、
// PanelHighlightOverlay.tsx から分けてある。
export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function queryPanelElement(panelId: PanelId): Element | null {
  if (panelId === "editor") {
    return document.querySelector("[data-editor-area]");
  }
  return document.querySelector(`[data-slot-panel="${panelId}"]`);
}

function estimateRegionRect(region: PanelRegion): Rect | null {
  const shell = document.querySelector("[data-layout-shell]");
  if (!shell) return null;
  const r = shell.getBoundingClientRect();

  switch (region) {
    case "left":
      return {
        left: r.left,
        top: r.top,
        width: r.width * 0.18,
        height: r.height,
      };
    case "right":
      return {
        left: r.left + r.width * 0.7,
        top: r.top,
        width: r.width * 0.3,
        height: r.height,
      };
    case "center-bottom":
      return {
        left: r.left + r.width * 0.18,
        top: r.top + r.height * 0.6,
        width: r.width * 0.52,
        height: r.height * 0.4,
      };
  }
}

export function getPanelRect(panelId: PanelId): Rect | null {
  const el = queryPanelElement(panelId);
  if (el) {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  }

  if (panelId === "editor") return null;
  const region = PANEL_REGION_MAP[panelId as Exclude<PanelId, "editor">];
  return estimateRegionRect(region);
}

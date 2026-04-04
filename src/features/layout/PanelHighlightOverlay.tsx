import { useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useLayoutStore, type PanelId } from "./layoutStore";
import { PANEL_REGION_MAP, type PanelRegion } from "./panelRegions";
import type { DockviewApi } from "dockview-react";

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

function getGroupRect(panelId: PanelId): Rect | null {
  const api = useLayoutStore.getState().dockviewApi;
  if (!api) return null;

  const panel = api.getPanel(panelId);

  // codex-quick: appears below the Scenes group in the left column.
  // If it's tabbed into the Scenes group or not visible at all, derive its
  // position from where the Scenes group ends rather than using the group rect.
  if (panelId === "codex-quick") {
    return estimateCodexQuickRect(api);
  }

  if (panel?.group?.element) {
    const r = panel.group.element.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  }

  // Panel not visible — estimate from region
  if (panelId === "editor") return null;
  const region = PANEL_REGION_MAP[panelId as Exclude<PanelId, "editor">];
  return estimateRegionRect(region);
}

function estimateCodexQuickRect(api: DockviewApi): Rect | null {
  const container = document.querySelector(".dockview-theme-dark");
  if (!container) return null;
  const cr = container.getBoundingClientRect();

  // If codex-quick has its own group below Scenes, use that group's rect
  const cqPanel = api.getPanel("codex-quick");
  const scenesPanel = api.getPanel("scenes");
  if (cqPanel?.group?.element && cqPanel.group !== scenesPanel?.group) {
    const r = cqPanel.group.element.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  }

  // Estimate: below the Scenes group
  if (scenesPanel?.group?.element) {
    const sr = scenesPanel.group.element.getBoundingClientRect();
    const bottom = cr.bottom;
    if (bottom > sr.bottom + 20) {
      return {
        left: sr.left,
        top: sr.bottom,
        width: sr.width,
        height: bottom - sr.bottom,
      };
    }
  }

  // Fallback: lower half of the estimated left column
  return {
    left: cr.left,
    top: cr.top + cr.height * 0.5,
    width: cr.width * 0.18,
    height: cr.height * 0.5,
  };
}

function estimateRegionRect(region: PanelRegion): Rect | null {
  const container = document.querySelector(".dockview-theme-dark");
  if (!container) return null;
  const r = container.getBoundingClientRect();

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

interface PanelHighlightOverlayProps {
  panelId: PanelId | null;
}

export function PanelHighlightOverlay({ panelId }: PanelHighlightOverlayProps) {
  const [rect, setRect] = useState<Rect | null>(null);
  const [isExact, setIsExact] = useState(false);

  useLayoutEffect(() => {
    if (!panelId) {
      setRect(null);
      return;
    }

    let rafId: number | null = null;

    function measure() {
      if (!panelId) return;
      const api = useLayoutStore.getState().dockviewApi;
      const panel = api?.getPanel(panelId);
      const exact = !!panel?.group?.element;
      setIsExact(exact);
      setRect(getGroupRect(panelId));
    }

    measure();

    // Track resizes
    const api = useLayoutStore.getState().dockviewApi;
    const panel = api?.getPanel(panelId);
    const target =
      panel?.group?.element ?? document.querySelector(".dockview-theme-dark");
    if (!target) return;

    const observer = new ResizeObserver(() => {
      rafId = requestAnimationFrame(measure);
    });
    observer.observe(target);
    return () => {
      observer.disconnect();
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [panelId]);

  if (!rect) return null;

  const style: React.CSSProperties = {
    position: "fixed",
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
    pointerEvents: "none",
    zIndex: 9999,
    transition: "all 150ms ease",
  };

  return createPortal(
    <div style={style}>
      {isExact ? (
        <div
          className="h-full w-full rounded"
          style={{
            background: "oklch(0.488 0.243 264 / 0.15)",
            boxShadow: "inset 0 0 0 2px oklch(0.488 0.243 264 / 0.5)",
          }}
        />
      ) : (
        <div
          className="h-full w-full rounded"
          style={{
            background: "oklch(0.488 0.243 264 / 0.08)",
            boxShadow: "inset 0 0 0 2px oklch(0.488 0.243 264 / 0.3)",
            borderStyle: "dashed",
          }}
        />
      )}
    </div>,
    document.body,
  );
}

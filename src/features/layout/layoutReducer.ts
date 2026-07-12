import {
  buildRegionSizeClampContext,
  clampLayoutStateForViewport,
  findPanelLocation,
  isCenterContentVisible,
  redistributeSpaceOnEditorClose,
  updateCenter,
  updateCenterToolSegment,
  updateRegion,
  validateLayoutState,
} from "./layoutStateUtils";
import { clampRegionSize } from "./layoutConstants";
import type {
  LayoutRegionId,
  LayoutState,
  RegionId,
  ToolWindowPanelId,
} from "./layoutTypes";
import type { PanelId } from "./panelIds";

export type LayoutAction =
  | { type: "editor/open"; viewport: { width: number; height: number } }
  | { type: "editor/close"; viewport: { width: number; height: number } }
  | { type: "panel/show"; panel: ToolWindowPanelId }
  | { type: "panel/hide"; panel: ToolWindowPanelId }
  | { type: "panel/toggle"; panel: ToolWindowPanelId }
  | {
      type: "resize/live";
      region: RegionId;
      size: number;
      viewport: { width: number; height: number };
    }
  | {
      type: "resize/finalize";
      viewport: { width: number; height: number };
    }
  | {
      type: "preset/apply";
      snapshot: LayoutState;
      viewport: { width: number; height: number };
    };

function applyValidated(
  layout: LayoutState,
  fallback: LayoutState,
  viewport: { width: number; height: number },
): LayoutState {
  const clamped = clampLayoutStateForViewport(layout, viewport);
  return validateLayoutState(clamped, { viewport }).valid ? clamped : fallback;
}

function reduceEditor(
  state: LayoutState,
  open: boolean,
  viewport: { width: number; height: number },
): LayoutState {
  if (state.center.editorOpen === open) return state;
  let next = updateCenter(state, (center) => ({ ...center, editorOpen: open }));
  if (!open) {
    if (!isCenterContentVisible(next)) {
      next = {
        ...next,
        collapsedEditorRegionSizes: {
          left: state.regions.left.size,
          right: state.regions.right.size,
        },
      };
    }
    next = redistributeSpaceOnEditorClose(next, viewport);
  } else if (state.collapsedEditorRegionSizes) {
    const memory = state.collapsedEditorRegionSizes;
    next = {
      ...next,
      regions: {
        ...next.regions,
        left: { ...next.regions.left, size: memory.left },
        right: { ...next.regions.right, size: memory.right },
      },
    };
    delete next.collapsedEditorRegionSizes;
  }
  return applyValidated(next, state, viewport);
}

function reduceToolPanel(
  state: LayoutState,
  panel: ToolWindowPanelId,
  mode: "show" | "hide" | "toggle",
): LayoutState {
  const location = findPanelLocation(state, panel);
  if (!location) return state;
  const active = location.slot.activePanel === panel;
  const nextActive = mode === "show" || (mode === "toggle" && !active);
  if (mode === "show" && active) return state;
  if (mode === "hide" && !active) return state;

  if (location.region === "center") {
    return updateCenterToolSegment(state, location.slot.id, (segment) => ({
      ...segment,
      activePanel: nextActive ? panel : null,
    }));
  }
  return updateRegion(state, location.region, (region) => ({
    ...region,
    slots: region.slots.map((slot) =>
      slot.id === location.slot.id
        ? { ...slot, activePanel: nextActive ? panel : null }
        : slot,
    ),
  }));
}

export function reduceLayout(
  state: LayoutState,
  action: LayoutAction,
): LayoutState {
  switch (action.type) {
    case "editor/open":
      return reduceEditor(state, true, action.viewport);
    case "editor/close":
      return reduceEditor(state, false, action.viewport);
    case "panel/show":
    case "panel/hide":
    case "panel/toggle":
      return applyValidated(
        reduceToolPanel(
          state,
          action.panel,
          action.type === "panel/show"
            ? "show"
            : action.type === "panel/hide"
              ? "hide"
              : "toggle",
        ),
        state,
        typeof window === "undefined"
          ? { width: 1200, height: 800 }
          : { width: window.innerWidth, height: window.innerHeight },
      );
    case "resize/live": {
      const clamped = clampRegionSize(
        action.region,
        action.size,
        action.viewport,
        buildRegionSizeClampContext(state),
      );
      if (clamped === state.regions[action.region].size) return state;
      const next = { ...state, regions: { ...state.regions } };
      next.regions[action.region] = {
        ...state.regions[action.region],
        size: clamped,
      };
      delete next.collapsedEditorRegionSizes;
      return applyValidated(next, state, action.viewport);
    }
    case "resize/finalize":
      return applyValidated(state, state, action.viewport);
    case "preset/apply":
      return applyValidated(action.snapshot, state, action.viewport);
  }
}

export function isLayoutPanel(panel: PanelId): panel is ToolWindowPanelId {
  return panel !== "editor";
}

export type { LayoutRegionId };

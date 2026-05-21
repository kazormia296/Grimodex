import type {
  LayoutState,
  LayoutRegionId,
  RegionId,
  ToolWindowPanelId,
} from "./layoutTypes";

export type NewSlotDropSurface =
  | "stripe-start"
  | "stripe-end"
  | "stripe-between"
  | "content-start"
  | "content-between"
  | "content-end";

export const TOOL_WINDOW_REASSIGN_TYPE =
  "application/grimodex-toolwindow-reassign";

export type DragOverTarget =
  | { type: "slot"; region: LayoutRegionId; slotId: string }
  | {
      type: "new-slot";
      region: LayoutRegionId;
      insertIndex: number;
      surface: NewSlotDropSurface;
    };

export interface DropTargetRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export const PANEL_POINTER_DRAG_THRESHOLD_PX = 6;

export function acceptsToolWindowReassignDrag(
  e: React.DragEvent,
  layoutLocked: boolean,
  draggingPanel?: string | null,
): boolean {
  if (layoutLocked) return false;
  if (draggingPanel) return true;
  return e.dataTransfer.types.includes(TOOL_WINDOW_REASSIGN_TYPE);
}

function parseRegion(value: string | undefined | null): LayoutRegionId | null {
  if (
    value === "left" ||
    value === "right" ||
    value === "bottom" ||
    value === "center"
  ) {
    return value;
  }
  return null;
}

export function resolveDropTargetFromElement(
  el: Element | null,
): DragOverTarget | null {
  let node: Element | null = el;
  while (node) {
    if (node instanceof HTMLElement) {
      const slotId = node.dataset.dropSlot;
      if (slotId) {
        const region =
          parseRegion(node.dataset.dropRegion) ??
          parseRegion(
            node
              .closest("[data-center-content]")
              ?.getAttribute("data-center-content")
              ? "center"
              : null,
          ) ??
          parseRegion(
            node
              .closest("[data-region-content]")
              ?.getAttribute("data-region-content"),
          );
        if (region) return { type: "slot", region, slotId };
      }

      const segmentSlotId = node.dataset.dropSlotId;
      if (node.hasAttribute("data-drop-segment") && segmentSlotId) {
        const region =
          parseRegion(node.dataset.dropRegion) ??
          parseRegion(
            node
              .closest("[data-stripe-region]")
              ?.getAttribute("data-stripe-region"),
          );
        if (region) {
          return { type: "slot", region, slotId: segmentSlotId };
        }
      }

      if (node.hasAttribute("data-drop-new-slot")) {
        const region =
          parseRegion(node.dataset.dropRegion) ??
          parseRegion(node.getAttribute("data-drop-new-slot"));
        const insertIndex = Number(node.dataset.insertIndex ?? "0");
        const surface = node.dataset.dropSurface as
          | NewSlotDropSurface
          | undefined;
        if (
          region &&
          (surface === "content-start" || surface === "content-end")
        ) {
          return {
            type: "new-slot",
            region,
            insertIndex,
            surface,
          };
        }
      }

      if (node.hasAttribute("data-drop-edge")) {
        const region = parseRegion(node.dataset.dropRegion);
        const insertIndex = Number(node.dataset.insertIndex ?? "0");
        const surface = node.dataset.dropSurface as
          | NewSlotDropSurface
          | undefined;
        if (
          region &&
          surface &&
          (surface === "stripe-start" ||
            surface === "stripe-end" ||
            surface === "stripe-between")
        ) {
          return { type: "new-slot", region, insertIndex, surface };
        }
      }

      if (node.hasAttribute("data-drop-between")) {
        const region =
          parseRegion(node.dataset.dropRegion) ??
          parseRegion(
            node
              .closest("[data-center-content]")
              ?.getAttribute("data-center-content")
              ? "center"
              : null,
          ) ??
          parseRegion(
            node
              .closest("[data-region-content]")
              ?.getAttribute("data-region-content"),
          );
        const insertIndex = Number(node.dataset.insertIndex ?? "0");
        const surface = node.dataset.dropSurface as
          | NewSlotDropSurface
          | undefined;
        if (region && surface === "content-between") {
          return { type: "new-slot", region, insertIndex, surface };
        }
      }
    }
    node = node.parentElement;
  }
  return null;
}

export function resolveDropTargetFromPoint(
  x: number,
  y: number,
): DragOverTarget | null {
  return resolveDropTargetFromElement(document.elementFromPoint(x, y));
}

export function performToolWindowDrop(
  target: DragOverTarget,
  panelId: ToolWindowPanelId,
  actions: {
    movePanelToSlot: (
      panel: ToolWindowPanelId,
      region: LayoutRegionId,
      slotId: string,
    ) => void;
    movePanelToNewSlot: (
      panel: ToolWindowPanelId,
      region: LayoutRegionId,
      insertIndex: number,
    ) => void;
  },
): void {
  if (target.type === "slot") {
    actions.movePanelToSlot(panelId, target.region, target.slotId);
    return;
  }
  actions.movePanelToNewSlot(panelId, target.region, target.insertIndex);
}

export function getDropTargetElement(target: DragOverTarget): Element | null {
  switch (target.type) {
    case "slot":
      return (
        document.querySelector(`[data-drop-slot="${target.slotId}"]`) ??
        document.querySelector(
          `[data-drop-segment][data-drop-slot-id="${target.slotId}"]`,
        )
      );
    case "new-slot":
      switch (target.surface) {
        case "stripe-start":
          return document.querySelector(
            `[data-stripe-region="${target.region}"] [data-drop-edge="start"]`,
          );
        case "stripe-end":
          return document.querySelector(
            `[data-stripe-region="${target.region}"] [data-drop-edge="end"]`,
          );
        case "stripe-between":
          return document.querySelector(
            `[data-stripe-region="${target.region}"] [data-drop-edge="between"][data-insert-index="${target.insertIndex}"]`,
          );
        case "content-start":
        case "content-end":
          return (
            document.querySelector(
              `[data-drop-new-slot="${target.region}"][data-drop-surface="${target.surface}"]`,
            ) ??
            document.querySelector(
              target.region === "center"
                ? "[data-center-content]"
                : `[data-region-content="${target.region}"]`,
            )
          );
        case "content-between":
          return target.region === "center"
            ? document.querySelector(
                `[data-center-content] [data-drop-between][data-insert-index="${target.insertIndex}"]`,
              )
            : document.querySelector(
                `[data-region-content="${target.region}"] [data-drop-between][data-insert-index="${target.insertIndex}"]`,
              );
      }
  }
}

export function countOpenSlotsBeforeIndex(
  slots: LayoutState["regions"][RegionId]["slots"],
  insertIndex: number,
): number {
  let count = 0;
  for (let i = 0; i < insertIndex && i < slots.length; i++) {
    if (slots[i].activePanel !== null) count++;
  }
  return count;
}

export function countOpenCenterSegmentsBeforeIndex(
  layout: LayoutState,
  insertIndex: number,
): number {
  let count = 0;
  for (let i = 0; i < insertIndex && i < layout.center.segments.length; i++) {
    const segment = layout.center.segments[i];
    if (segment.kind === "editor") {
      if (layout.center.editorOpen) count++;
    } else if (segment.activePanel !== null) {
      count++;
    }
  }
  return count;
}

export function getNewSlotPreviewRect(
  target: Extract<DragOverTarget, { type: "new-slot" }>,
  layout: LayoutState,
): DropTargetRect | null {
  if (target.region === "center") {
    const container = document.querySelector("[data-center-content]");
    if (!container) return null;

    const containerRect = container.getBoundingClientRect();
    if (containerRect.width <= 0 || containerRect.height <= 0) return null;

    const openCount = layout.center.segments.filter((segment) => {
      if (segment.kind === "editor") return layout.center.editorOpen;
      return segment.activePanel !== null;
    }).length;
    const openBefore = countOpenCenterSegmentsBeforeIndex(
      layout,
      target.insertIndex,
    );
    const totalSlots = openCount + 1;
    const share = containerRect.width / totalSlots;
    if (share <= 0) return null;
    return {
      left: containerRect.left + openBefore * share,
      top: containerRect.top,
      width: share,
      height: containerRect.height,
    };
  }

  const container = document.querySelector(
    `[data-region-content="${target.region}"]`,
  );
  if (!container) return null;

  const containerRect = container.getBoundingClientRect();
  if (containerRect.width <= 0 || containerRect.height <= 0) return null;

  const slots = layout.regions[target.region as RegionId].slots;
  const openCount = slots.filter((slot) => slot.activePanel !== null).length;
  const openBefore = countOpenSlotsBeforeIndex(slots, target.insertIndex);
  const isHorizontal = target.region === "bottom";
  const totalSlots = openCount + 1;

  if (isHorizontal) {
    const share = containerRect.width / totalSlots;
    if (share <= 0) return null;
    return {
      left: containerRect.left + openBefore * share,
      top: containerRect.top,
      width: share,
      height: containerRect.height,
    };
  }

  const share = containerRect.height / totalSlots;
  if (share <= 0) return null;
  return {
    left: containerRect.left,
    top: containerRect.top + openBefore * share,
    width: containerRect.width,
    height: share,
  };
}

export function getDropTargetRect(
  target: DragOverTarget,
  layout?: LayoutState,
): DropTargetRect | null {
  if (target.type === "new-slot" && layout) {
    const preview = getNewSlotPreviewRect(target, layout);
    if (preview) return preview;
  }

  const el = getDropTargetElement(target);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return null;
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

export function dragTargetsEqual(
  a: DragOverTarget | null,
  b: DragOverTarget | null,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.type !== b.type) return false;
  if (a.type === "slot" && b.type === "slot") {
    return a.region === b.region && a.slotId === b.slotId;
  }
  if (a.type === "new-slot" && b.type === "new-slot") {
    return (
      a.region === b.region &&
      a.insertIndex === b.insertIndex &&
      a.surface === b.surface
    );
  }
  return false;
}

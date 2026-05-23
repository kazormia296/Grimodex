import { STRIPE_DRAG_DETECTION_PAD_PX } from "./layoutConstants";
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
      type: "stripe-reorder";
      region: LayoutRegionId;
      slotId: string;
      insertIndex: number;
    }
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

/**
 * Gap stickiness for stripe icon insert index.
 * Pattern reference: leoweyr/react-ide-workspace-layout GlobalSideBar.calculateIndexInGroup
 * https://github.com/leoweyr/react-ide-workspace-layout
 */
export function calculateStripeInsertIndex(
  container: HTMLElement,
  mouseCoord: number,
  orientation: "vertical" | "horizontal",
  prevIndex: number = -1,
): number {
  const children = container.querySelectorAll("[data-stripe-icon]");
  const count = children.length;
  if (count === 0) return 0;

  for (let i = 0; i < count; i++) {
    const rect = children[i].getBoundingClientRect();
    const start = orientation === "vertical" ? rect.top : rect.left;
    const end = orientation === "vertical" ? rect.bottom : rect.right;

    if (mouseCoord >= start && mouseCoord <= end) {
      return i;
    }
    if (i === 0 && mouseCoord < start) return 0;
    if (i === count - 1 && mouseCoord > end) return count;

    if (i < count - 1) {
      const nextRect = children[i + 1].getBoundingClientRect();
      const nextStart =
        orientation === "vertical" ? nextRect.top : nextRect.left;
      if (mouseCoord > end && mouseCoord < nextStart) {
        if (prevIndex === i || prevIndex === i + 1) {
          return prevIndex;
        }
        return mouseCoord - end < nextStart - mouseCoord ? i : i + 1;
      }
    }
  }

  return count;
}

function parseInsertIndex(value: string | undefined): number {
  const n = Number(value ?? "0");
  return Number.isFinite(n) ? n : 0;
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

      if (node.hasAttribute("data-drop-stripe-reorder")) {
        const region =
          parseRegion(node.dataset.dropRegion) ??
          parseRegion(
            node
              .closest("[data-stripe-region]")
              ?.getAttribute("data-stripe-region"),
          );
        const slotId = node.dataset.dropSlotId;
        if (region && slotId) {
          return {
            type: "stripe-reorder",
            region,
            slotId,
            insertIndex: parseInsertIndex(node.dataset.insertIndex),
          };
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

function isPointInPaddedStripeRegion(
  x: number,
  y: number,
  stripeRoot: HTMLElement,
  pad: number = STRIPE_DRAG_DETECTION_PAD_PX,
): boolean {
  const rect = stripeRoot.getBoundingClientRect();
  return (
    x >= rect.left - pad &&
    x <= rect.right + pad &&
    y >= rect.top - pad &&
    y <= rect.bottom + pad
  );
}

function resolveStripeReorderFromSegment(
  segmentEl: HTMLElement,
  x: number,
  y: number,
  region: LayoutRegionId,
  slotId: string,
  prevIndex: number,
): DragOverTarget | null {
  const stripeRoot = segmentEl.closest<HTMLElement>("[data-stripe-root]");
  if (!stripeRoot || !isPointInPaddedStripeRegion(x, y, stripeRoot)) {
    return null;
  }

  const orientation =
    stripeRoot.getAttribute("data-stripe-region") === "bottom" ||
    stripeRoot.closest("[data-region-dock='bottom']")
      ? "horizontal"
      : stripeRoot.getAttribute("data-stripe-region") === "center"
        ? "horizontal"
        : "vertical";

  const mouseCoord = orientation === "vertical" ? y : x;
  const insertIndex = calculateStripeInsertIndex(
    segmentEl,
    mouseCoord,
    orientation,
    prevIndex,
  );

  return {
    type: "stripe-reorder",
    region,
    slotId,
    insertIndex,
  };
}

export interface ResolveDropTargetOptions {
  draggingPanel?: ToolWindowPanelId | null;
  sourceSlotId?: string | null;
  prevTarget?: DragOverTarget | null;
}

export function resolveDropTargetFromPoint(
  x: number,
  y: number,
  options?: ResolveDropTargetOptions,
): DragOverTarget | null {
  const el = document.elementFromPoint(x, y);
  const direct = resolveDropTargetFromElement(el);
  if (direct?.type === "stripe-reorder") return direct;
  if (direct && direct.type !== "slot") return direct;

  const draggingPanel = options?.draggingPanel;
  const sourceSlotId = options?.sourceSlotId;
  const prevIndex =
    options?.prevTarget?.type === "stripe-reorder"
      ? options.prevTarget.insertIndex
      : -1;

  if (draggingPanel && sourceSlotId && el) {
    const segmentEl =
      el.closest<HTMLElement>("[data-drop-segment]") ??
      el.closest<HTMLElement>("[data-drop-slot-id]");
    if (segmentEl) {
      const slotId =
        segmentEl.dataset.dropSlotId ?? segmentEl.dataset.dropSegment;
      const region =
        parseRegion(segmentEl.dataset.dropRegion) ??
        parseRegion(
          segmentEl
            .closest("[data-stripe-region]")
            ?.getAttribute("data-stripe-region"),
        );
      if (region && slotId === sourceSlotId) {
        const reorder = resolveStripeReorderFromSegment(
          segmentEl,
          x,
          y,
          region,
          slotId,
          prevIndex,
        );
        if (reorder) return reorder;
      }
    }
  }

  if (direct?.type === "slot" && draggingPanel && sourceSlotId) {
    if (direct.slotId === sourceSlotId) {
      const segmentEl = document.querySelector<HTMLElement>(
        `[data-drop-slot-id="${sourceSlotId}"]`,
      );
      if (segmentEl) {
        const reorder = resolveStripeReorderFromSegment(
          segmentEl,
          x,
          y,
          direct.region,
          sourceSlotId,
          prevIndex,
        );
        if (reorder) return reorder;
      }
    }
    return direct;
  }

  return direct;
}

export interface CenterStripeDropSegment {
  kind: "editor" | "tool";
  slotId: string;
  open: boolean;
  sizeRatio: number;
}

export function centerInsertIndexAfter(
  layout: LayoutState,
  segmentId: string,
): number {
  const ids = layout.center.segments.map((seg) => seg.id);
  const index = ids.indexOf(segmentId);
  return index < 0 ? ids.length : index + 1;
}

function pointInRect(x: number, y: number, rect: DOMRect): boolean {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

function insertIndexFromStripeRatio(
  clientX: number,
  rootRect: DOMRect,
  segments: ReadonlyArray<CenterStripeDropSegment>,
  slotIds: ReadonlyArray<string>,
): number {
  const openSegments = segments.filter((segment) => segment.open);
  if (openSegments.length === 0) {
    const editor = segments.find((segment) => segment.kind === "editor");
    if (!editor) return slotIds.length;
    const index = slotIds.indexOf(editor.slotId);
    return index < 0 ? slotIds.length : index + 1;
  }

  const totalRatio = openSegments.reduce(
    (sum, segment) => sum + segment.sizeRatio,
    0,
  );
  const xRatio = (clientX - rootRect.left) / Math.max(rootRect.width, 1);
  let boundary = 0;

  for (const segment of openSegments) {
    boundary += segment.sizeRatio / totalRatio;
    const slotIndex = slotIds.indexOf(segment.slotId);
    if (xRatio <= boundary) {
      return slotIndex < 0 ? slotIds.length : slotIndex + 1;
    }
  }

  return slotIds.length;
}

/** Hit-test Center Stripe using band geometry and open-segment ratios (overlay sits on top). */
export function resolveCenterStripeDropFromPoint(
  clientX: number,
  clientY: number,
  segments: ReadonlyArray<CenterStripeDropSegment>,
  slotIds: ReadonlyArray<string>,
  stripeEndInsertIndex: number,
  layout: LayoutState,
): DragOverTarget | null {
  const root = document.querySelector<HTMLElement>(
    '[data-stripe-region="center"][data-stripe-root]',
  );
  if (!root) return null;

  const rootRect = root.getBoundingClientRect();

  // CenterStripe 全幅オーバーレイから呼ばれるため、バンド列(root)の左右外側
  // （= left/right region content 列の上）にも対応する。左外は先頭、右外は
  // 末尾へ新規 slot を挿入する。
  if (clientX < rootRect.left) {
    return {
      type: "new-slot",
      region: "center",
      insertIndex: 0,
      surface: "stripe-start",
    };
  }
  if (clientX > rootRect.right) {
    return {
      type: "new-slot",
      region: "center",
      insertIndex: stripeEndInsertIndex,
      surface: "stripe-end",
    };
  }
  if (!pointInRect(clientX, clientY, rootRect)) return null;

  const bands = [
    ...root.querySelectorAll<HTMLElement>("[data-center-stripe-band]"),
  ].sort(
    (a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left,
  );

  for (const band of bands) {
    const rect = band.getBoundingClientRect();
    if (!pointInRect(clientX, clientY, rect)) continue;

    const kind = band.dataset.centerStripeBandKind;
    const slotId = band.dataset.centerStripeSlotId;
    if (!slotId) continue;

    if (kind === "tool") {
      return { type: "slot", region: "center", slotId };
    }
    if (kind === "editor") {
      return {
        type: "new-slot",
        region: "center",
        insertIndex: centerInsertIndexAfter(layout, slotId),
        surface: "stripe-end",
      };
    }
  }

  const insertIndex = insertIndexFromStripeRatio(
    clientX,
    rootRect,
    segments,
    slotIds,
  );

  return {
    type: "new-slot",
    region: "center",
    insertIndex,
    surface: "stripe-end",
  };
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
    reorderPanelInSlot: (
      panel: ToolWindowPanelId,
      region: LayoutRegionId,
      slotId: string,
      insertIndex: number,
    ) => void;
  },
): void {
  if (target.type === "stripe-reorder") {
    actions.reorderPanelInSlot(
      panelId,
      target.region,
      target.slotId,
      target.insertIndex,
    );
    return;
  }
  if (target.type === "slot") {
    actions.movePanelToSlot(panelId, target.region, target.slotId);
    return;
  }
  actions.movePanelToNewSlot(panelId, target.region, target.insertIndex);
}

export function getDropTargetElement(target: DragOverTarget): Element | null {
  switch (target.type) {
    case "stripe-reorder":
      return (
        document.querySelector(
          `[data-drop-stripe-reorder][data-drop-slot-id="${target.slotId}"][data-insert-index="${target.insertIndex}"]`,
        ) ?? document.querySelector(`[data-drop-slot-id="${target.slotId}"]`)
      );
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
          if (target.region === "center") {
            return (
              document.querySelector("[data-center-stripe-drop-overlay]") ??
              document.querySelector(
                `[data-stripe-region="${target.region}"] [data-drop-edge="end"]`,
              )
            );
          }
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
  if (a.type === "stripe-reorder" && b.type === "stripe-reorder") {
    return (
      a.region === b.region &&
      a.slotId === b.slotId &&
      a.insertIndex === b.insertIndex
    );
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

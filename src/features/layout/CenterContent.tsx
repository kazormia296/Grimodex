import { Fragment, memo, useCallback, useRef } from "react";
import { cn } from "@/lib/utils";
import {
  acceptsToolWindowReassignDrag,
  TOOL_WINDOW_REASSIGN_TYPE,
} from "./layoutDnD";
import { useLayoutStore } from "./layoutStore";
import {
  DND_NEW_SLOT_BETWEEN_HALF_PX,
  DND_NEW_SLOT_EDGE_HIT_PX,
  MIN_EDITOR_SIZE,
  MIN_SLOT_SIZE,
  PANEL_GAP_PX,
} from "./layoutConstants";
import { useDragDropZonesReady } from "./useDragDropZonesReady";
import { Splitter } from "./Splitter";
import { AnimatedSlotPanel } from "./AnimatedSlotPanel";
import { EditorArea } from "./EditorArea";
import { normalizeFlexGrow } from "./layoutStateUtils";
import type { CenterSegment } from "./layoutTypes";

function centerSegmentVisible(
  segment: CenterSegment,
  editorOpen: boolean,
): boolean {
  if (segment.kind === "editor") return editorOpen;
  return segment.activePanel !== null;
}

interface CenterContentProps {
  zenMode?: boolean;
  editorOnly?: boolean;
}

export const CenterContent = memo(function CenterContent({
  zenMode = false,
  editorOnly = false,
}: CenterContentProps) {
  const center = useLayoutStore((s) => s.layout.center);
  const layoutLocked = useLayoutStore((s) => s.layoutLocked);
  const containerRef = useRef<HTMLDivElement>(null);
  const nudgeAdjacentCenterSegmentSizes = useLayoutStore(
    (s) => s.nudgeAdjacentCenterSegmentSizes,
  );
  const finalizeLayoutResize = useLayoutStore((s) => s.finalizeLayoutResize);
  const movePanelToSlot = useLayoutStore((s) => s.movePanelToSlot);
  const movePanelToNewSlot = useLayoutStore((s) => s.movePanelToNewSlot);
  const draggingPanel = useLayoutStore((s) => s.draggingPanel);
  const setDraggingPanel = useLayoutStore((s) => s.setDraggingPanel);
  const setDragOverTarget = useLayoutStore((s) => s.setDragOverTarget);
  const showDropZones = useDragDropZonesReady(
    Boolean(draggingPanel && !layoutLocked && !zenMode && !editorOnly),
  );

  const maximizedPanelId = useLayoutStore((s) => s.maximizedPanelId);
  const effectiveMaximizedPanelId =
    zenMode || editorOnly ? "editor" : maximizedPanelId;

  const visibleSegments = center.segments.filter((segment) => {
    if (editorOnly && segment.kind === "editor") return true;
    return centerSegmentVisible(segment, center.editorOpen);
  });

  const segmentFlexGrow = normalizeFlexGrow(
    visibleSegments.map((s) => s.sizeRatio),
  );

  // 視覚 zoom: 対象が center band 内（editor / tool segment）のときだけ
  // 対象 segment を全面化し、非対象 segment / splitter を 0 サイズ +
  // 不可視にする（unmount はしない — visibleSegments のフィルタ条件は
  // 変えない。editor unmount 回避の要）。
  const zoomActive = effectiveMaximizedPanelId !== null;
  const zoomedSegmentId =
    effectiveMaximizedPanelId === null
      ? null
      : effectiveMaximizedPanelId === "editor"
        ? (visibleSegments.find((s) => s.kind === "editor")?.id ?? null)
        : (visibleSegments.find(
            (s) =>
              s.kind === "tool" && s.activePanel === effectiveMaximizedPanelId,
          )?.id ?? null);

  const getLayoutBudgetPx = useCallback(() => {
    const el = containerRef.current;
    if (!el) return 0;
    return el.getBoundingClientRect().width;
  }, []);

  const handleSlotDrop = useCallback(
    (slotId: string, e: React.DragEvent) => {
      e.preventDefault();
      if (layoutLocked) return;
      const panelId =
        draggingPanel ??
        (e.dataTransfer.getData(TOOL_WINDOW_REASSIGN_TYPE) as
          | import("./layoutTypes").ToolWindowPanelId
          | "");
      if (!panelId) return;
      movePanelToSlot(panelId, "center", slotId);
      setDraggingPanel(null);
      setDragOverTarget(null);
    },
    [
      draggingPanel,
      layoutLocked,
      movePanelToSlot,
      setDragOverTarget,
      setDraggingPanel,
    ],
  );

  const handleSlotDragOver = useCallback(
    (slotId: string, e: React.DragEvent) => {
      if (!acceptsToolWindowReassignDrag(e, layoutLocked, draggingPanel))
        return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setDragOverTarget({ type: "slot", region: "center", slotId });
    },
    [layoutLocked, setDragOverTarget, draggingPanel],
  );

  const handleSlotDragLeave = useCallback(
    (e: React.DragEvent) => {
      if (e.currentTarget.contains(e.relatedTarget as Node)) return;
      setDragOverTarget(null);
    },
    [setDragOverTarget],
  );

  const handleNewSlotDragOver = useCallback(
    (
      insertIndex: number,
      surface: "content-start" | "content-end",
      e: React.DragEvent,
    ) => {
      if (!acceptsToolWindowReassignDrag(e, layoutLocked, draggingPanel))
        return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setDragOverTarget({
        type: "new-slot",
        region: "center",
        insertIndex,
        surface,
      });
    },
    [draggingPanel, layoutLocked, setDragOverTarget],
  );

  const handleBetweenSlotDragOver = useCallback(
    (insertIndex: number, e: React.DragEvent) => {
      if (!acceptsToolWindowReassignDrag(e, layoutLocked, draggingPanel))
        return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setDragOverTarget({
        type: "new-slot",
        region: "center",
        insertIndex,
        surface: "content-between",
      });
    },
    [draggingPanel, layoutLocked, setDragOverTarget],
  );

  const handleNewSlotDrop = useCallback(
    (insertIndex: number, e: React.DragEvent) => {
      e.preventDefault();
      if (layoutLocked || !draggingPanel) return;
      movePanelToNewSlot(draggingPanel, "center", insertIndex);
      setDraggingPanel(null);
      setDragOverTarget(null);
    },
    [
      draggingPanel,
      layoutLocked,
      movePanelToNewSlot,
      setDragOverTarget,
      setDraggingPanel,
    ],
  );

  const contentEndInsertIndex = center.segments.length;
  const contentStartInsertIndex = 0;

  if (visibleSegments.length === 0) return null;

  return (
    <div
      ref={containerRef}
      data-center-content
      className="relative flex h-full min-h-0 w-full min-w-0 flex-row"
    >
      {visibleSegments.map((segment, index) => {
        const segmentZoomHidden =
          zoomedSegmentId !== null && segment.id !== zoomedSegmentId;
        const minWidth =
          segment.kind === "editor" ? MIN_EDITOR_SIZE : MIN_SLOT_SIZE;
        const sizeStyle: React.CSSProperties = {
          flexGrow: segmentFlexGrow[index],
          flexBasis: 0,
          flexShrink: 0,
          minWidth,
          minHeight: 0,
        };
        if (zoomedSegmentId !== null) {
          sizeStyle.flexGrow = segment.id === zoomedSegmentId ? 1 : 0;
          if (segmentZoomHidden) {
            // minWidth (MIN_EDITOR_SIZE 等) が残ると 0 幅に潰れないため必ず 0 に。
            sizeStyle.minWidth = 0;
            sizeStyle.visibility = "hidden";
          }
        }

        return (
          <Fragment key={segment.id}>
            {index > 0 && (
              <div
                // `flex` で SplitterHandle を cross-axis stretch させる。
                // block 配置だと SplitterChrome の height: 100% が親を
                // 参照できず潰れる。zoom 中はギャップごと 0 サイズ + 不可視
                // （splitter はマウント維持、dev のヒット領域 assertion は
                // disabled で抑止）。
                className="relative flex shrink-0"
                style={
                  zoomedSegmentId !== null
                    ? { width: 0, visibility: "hidden" }
                    : { width: PANEL_GAP_PX }
                }
              >
                <Splitter
                  orientation="horizontal"
                  thickness={PANEL_GAP_PX}
                  disabled={layoutLocked || zoomActive}
                  onDrag={(delta) => {
                    const prevSegment = visibleSegments[index - 1];
                    const layoutBudgetPx = getLayoutBudgetPx();
                    if (layoutBudgetPx <= 0) return;
                    nudgeAdjacentCenterSegmentSizes(
                      prevSegment.id,
                      segment.id,
                      delta,
                      layoutBudgetPx,
                    );
                  }}
                  onDragEnd={finalizeLayoutResize}
                />
                {showDropZones && (
                  <div
                    data-drop-between
                    data-drop-region="center"
                    data-insert-index={index}
                    data-drop-surface="content-between"
                    className="absolute bottom-0 top-0 z-30 cursor-col-resize opacity-0"
                    style={{
                      left: -DND_NEW_SLOT_BETWEEN_HALF_PX,
                      right: -DND_NEW_SLOT_BETWEEN_HALF_PX,
                    }}
                    onDragOver={(e) => handleBetweenSlotDragOver(index, e)}
                    onDragLeave={handleSlotDragLeave}
                    onDrop={(e) => handleNewSlotDrop(index, e)}
                  />
                )}
              </div>
            )}
            {segment.kind === "editor" ? (
              <div
                data-center-segment={segment.id}
                data-center-segment-kind="editor"
                style={sizeStyle}
                aria-hidden={segmentZoomHidden || undefined}
                inert={segmentZoomHidden || undefined}
                className={cn(
                  "relative flex min-h-0 min-w-0 flex-col",
                  !center.editorOpen && !editorOnly && "hidden",
                )}
              >
                <EditorArea />
              </div>
            ) : (
              <div
                data-drop-slot={segment.id}
                data-drop-region="center"
                data-center-segment={segment.id}
                data-center-segment-kind="tool"
                data-ambient-glass-surface="panel"
                style={sizeStyle}
                aria-hidden={segmentZoomHidden || undefined}
                inert={segmentZoomHidden || undefined}
                className={cn(
                  "gx-panel relative flex min-h-0 min-w-0 flex-col overflow-hidden",
                  draggingPanel === segment.activePanel && "gx-panel--dragging",
                )}
                onDragOver={(e) => handleSlotDragOver(segment.id, e)}
                onDragLeave={handleSlotDragLeave}
                onDrop={(e) => handleSlotDrop(segment.id, e)}
              >
                {segment.activePanel && (
                  <AnimatedSlotPanel
                    panelId={segment.activePanel}
                    slotPanels={segment.panels}
                  />
                )}
              </div>
            )}
          </Fragment>
        );
      })}

      {showDropZones && (
        <>
          <div
            data-drop-new-slot="center"
            data-drop-region="center"
            data-insert-index={contentStartInsertIndex}
            data-drop-surface="content-start"
            className="absolute z-10 opacity-0"
            style={{
              top: 0,
              bottom: 0,
              left: 0,
              width: DND_NEW_SLOT_EDGE_HIT_PX,
            }}
            onDragOver={(e) =>
              handleNewSlotDragOver(contentStartInsertIndex, "content-start", e)
            }
            onDragLeave={handleSlotDragLeave}
            onDrop={(e) => handleNewSlotDrop(contentStartInsertIndex, e)}
          />
          <div
            data-drop-new-slot="center"
            data-drop-region="center"
            data-insert-index={contentEndInsertIndex}
            data-drop-surface="content-end"
            className="absolute z-10 opacity-0"
            style={{
              top: 0,
              bottom: 0,
              right: 0,
              width: DND_NEW_SLOT_EDGE_HIT_PX,
            }}
            onDragOver={(e) =>
              handleNewSlotDragOver(contentEndInsertIndex, "content-end", e)
            }
            onDragLeave={handleSlotDragLeave}
            onDrop={(e) => handleNewSlotDrop(contentEndInsertIndex, e)}
          />
        </>
      )}
    </div>
  );
});

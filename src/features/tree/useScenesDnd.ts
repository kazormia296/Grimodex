import { useCallback, useRef, useState } from "react";
import type { RefObject } from "react";
import {
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import type {
  DragStartEvent,
  DragEndEvent,
  DragMoveEvent,
} from "@dnd-kit/core";
import { cmpKeys } from "./fractionalIndex";
import { resolveTreeDropZone, type TreeDropPosition } from "./treeDropZone";
import { canHaveChildren, useTreeStore } from "./treeStore";
import type { TreeNodeData } from "./treeStore";
import type { DropIndicator } from "./TreeNodeItem";
import { BOTTOM_DROP_ZONE_ID } from "./BottomDropZone";

interface DndArgs {
  nodeMap: Record<string, TreeNodeData>;
  childMap: Record<string, string[]>;
  flatNodes: TreeNodeData[];
  moveNode: (
    id: string,
    newParentId: string | null,
    afterId: string | null,
  ) => Promise<void>;
  /** ドロップ指示の data 属性を書き込む対象を限定するコンテナ。
   *  未指定時は document 全体から探す。 */
  containerRef?: RefObject<HTMLElement | null>;
}

function escapeAttr(id: string): string {
  return typeof CSS !== "undefined" && typeof CSS.escape === "function"
    ? CSS.escape(id)
    : id.replace(/"/g, '\\"');
}

/** Encapsulates @dnd-kit handlers, sensors, and live drop indicator state for
 *  the Scenes tree. */
export function useScenesDnd({
  nodeMap,
  childMap,
  flatNodes,
  moveNode,
  containerRef,
}: DndArgs) {
  const pointerYRef = useRef(0);
  const [draggingId, setDraggingId] = useState<string | null>(null);

  // ドロップ指示は React state にしない。mousemove 由来の高頻度更新で
  // ツリー全行が再レンダーされるため (Grid D&D と同型の既知ボトルネック)、
  // 対象行の data 属性を直接書き換え、見た目は TreeNodeItem 側の
  // data-[drop-*] Tailwind variant が担う。React は li 上の data-drop-* /
  // 行 div 上の data-drop-inside を JSX で管理していないので、行が
  // 再レンダーされても属性は消えない (gate: TreeRenderer.perf.test.tsx)。
  const dropIndicatorRef = useRef<DropIndicator | null>(null);
  const applyDropIndicator = useCallback(
    (next: DropIndicator | null) => {
      const prev = dropIndicatorRef.current;
      if (prev?.nodeId === next?.nodeId && prev?.position === next?.position) {
        return;
      }
      dropIndicatorRef.current = next;
      const root: ParentNode = containerRef?.current ?? document;
      if (prev) {
        const li = root.querySelector(
          `[data-node-id="${escapeAttr(prev.nodeId)}"]`,
        );
        li?.removeAttribute("data-drop-before");
        li?.removeAttribute("data-drop-after");
        root
          .querySelector(`[data-node-row="${escapeAttr(prev.nodeId)}"]`)
          ?.removeAttribute("data-drop-inside");
      }
      if (next) {
        if (next.position === "inside") {
          root
            .querySelector(`[data-node-row="${escapeAttr(next.nodeId)}"]`)
            ?.setAttribute("data-drop-inside", "true");
        } else {
          root
            .querySelector(`[data-node-id="${escapeAttr(next.nodeId)}"]`)
            ?.setAttribute(
              next.position === "before"
                ? "data-drop-before"
                : "data-drop-after",
              "true",
            );
        }
      }
    },
    [containerRef],
  );

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor),
  );

  const onDragStart = useCallback(({ active }: DragStartEvent) => {
    setDraggingId(active.id as string);
  }, []);

  const onDragMove = useCallback(({ activatorEvent, delta }: DragMoveEvent) => {
    if (activatorEvent instanceof PointerEvent) {
      pointerYRef.current = activatorEvent.clientY + delta.y;
    }
  }, []);

  const onDragEnd = useCallback(
    ({ active, over }: DragEndEvent) => {
      setDraggingId(null);
      applyDropIndicator(null);
      if (active.id === over?.id) return;

      const activeId = active.id as string;
      const activeNode = nodeMap[activeId];
      if (!activeNode) return;
      if (!over) return;

      const rawOverId = String(over.id);

      if (rawOverId === BOTTOM_DROP_ZONE_ID) {
        const lastNode = flatNodes
          .filter((n) => n.id !== activeId)
          .slice(-1)[0];
        if (!lastNode) return;
        const parentNode = lastNode.parentId
          ? nodeMap[lastNode.parentId]
          : null;
        if (parentNode && !canHaveChildren(parentNode.nodeType)) return;
        moveNode(activeId, lastNode.parentId, lastNode.id).catch(() => {});
        return;
      }

      const overId = rawOverId.replace(/^drop-/, "");
      if (activeId === overId) return;

      const overNode = nodeMap[overId];
      if (!overNode) return;

      const overRect = over.rect;
      const pointerY = pointerYRef.current;
      const position: TreeDropPosition = overRect
        ? resolveTreeDropZone(
            pointerY,
            overRect,
            overNode.nodeType === "folder",
          )
        : "after";

      let newParentId: string | null;
      let afterId: string | null;
      if (position === "inside") {
        newParentId = overId;
        afterId = null;
      } else {
        newParentId = overNode.parentId;
        if (position === "after") {
          afterId = overId;
        } else {
          const siblings = childMap[newParentId ?? "root"] ?? [];
          const idx = siblings.indexOf(overId);
          afterId = idx > 0 ? siblings[idx - 1] : null;
        }
      }

      const parentNode = newParentId ? nodeMap[newParentId] : null;
      if (parentNode && !canHaveChildren(parentNode.nodeType)) return;

      const { selectedIds } = useTreeStore.getState();
      if (selectedIds.includes(activeId) && selectedIds.length > 1) {
        const selectedNodes = selectedIds
          .map((id) => nodeMap[id])
          .filter(Boolean)
          .sort((a, b) =>
            cmpKeys(a!.sortOrder, b!.sortOrder),
          ) as TreeNodeData[];
        let prevAfterId = afterId;
        for (const selNode of selectedNodes) {
          moveNode(selNode.id, newParentId, prevAfterId).catch(() => {});
          prevAfterId = selNode.id;
        }
      } else {
        moveNode(activeId, newParentId, afterId).catch(() => {});
      }
    },
    [nodeMap, childMap, moveNode, flatNodes, applyDropIndicator],
  );

  const onDragOver = useCallback(
    ({ active, over }: DragMoveEvent) => {
      if (!over) {
        applyDropIndicator(null);
        return;
      }

      const rawOverId = String(over.id);

      if (rawOverId === BOTTOM_DROP_ZONE_ID) {
        const lastNode = flatNodes
          .filter((n) => n.id !== String(active.id))
          .slice(-1)[0];
        if (lastNode) {
          applyDropIndicator({ nodeId: lastNode.id, position: "after" });
        } else {
          applyDropIndicator(null);
        }
        return;
      }

      const overId = rawOverId.replace(/^drop-/, "");
      if (active.id === overId) {
        applyDropIndicator(null);
        return;
      }
      const overNode = nodeMap[overId];
      if (!overNode) {
        applyDropIndicator(null);
        return;
      }

      const overRect = over.rect;
      if (!overRect) {
        applyDropIndicator(null);
        return;
      }
      const pointerY = pointerYRef.current;
      const position = resolveTreeDropZone(
        pointerY,
        overRect,
        overNode.nodeType === "folder",
      );
      applyDropIndicator({ nodeId: overId, position });
    },
    [nodeMap, flatNodes, applyDropIndicator],
  );

  // Escape 等での中断時も overlay と指示の残骸を残さない
  const onDragCancel = useCallback(() => {
    setDraggingId(null);
    applyDropIndicator(null);
  }, [applyDropIndicator]);

  return {
    sensors,
    draggingId,
    onDragStart,
    onDragMove,
    onDragEnd,
    onDragOver,
    onDragCancel,
  };
}

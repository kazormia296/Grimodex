import { useCallback, useRef, useState } from "react";
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
}

/** Encapsulates @dnd-kit handlers, sensors, and live drop indicator state for
 *  the Scenes tree. */
export function useScenesDnd({
  nodeMap,
  childMap,
  flatNodes,
  moveNode,
}: DndArgs) {
  const pointerYRef = useRef(0);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropIndicator, setDropIndicator] = useState<DropIndicator | null>(
    null,
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
      setDropIndicator(null);
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
    [nodeMap, childMap, moveNode, flatNodes],
  );

  const onDragOver = useCallback(
    ({ active, over }: DragMoveEvent) => {
      if (!over) {
        setDropIndicator(null);
        return;
      }

      const rawOverId = String(over.id);

      if (rawOverId === BOTTOM_DROP_ZONE_ID) {
        const lastNode = flatNodes
          .filter((n) => n.id !== String(active.id))
          .slice(-1)[0];
        if (lastNode) {
          setDropIndicator({ nodeId: lastNode.id, position: "after" });
        } else {
          setDropIndicator(null);
        }
        return;
      }

      const overId = rawOverId.replace(/^drop-/, "");
      if (active.id === overId) {
        setDropIndicator(null);
        return;
      }
      const overNode = nodeMap[overId];
      if (!overNode) {
        setDropIndicator(null);
        return;
      }

      const overRect = over.rect;
      if (!overRect) {
        setDropIndicator(null);
        return;
      }
      const pointerY = pointerYRef.current;
      const position = resolveTreeDropZone(
        pointerY,
        overRect,
        overNode.nodeType === "folder",
      );
      setDropIndicator({ nodeId: overId, position });
    },
    [nodeMap, flatNodes],
  );

  return {
    sensors,
    draggingId,
    dropIndicator,
    onDragStart,
    onDragMove,
    onDragEnd,
    onDragOver,
  };
}

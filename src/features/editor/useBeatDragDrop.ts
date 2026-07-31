import { useCallback, useRef, useState } from "react";
import {
  PointerSensor,
  pointerWithin,
  rectIntersection,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import type {
  CollisionDetection,
  DragEndEvent,
  DragStartEvent,
} from "@dnd-kit/core";
import type { Editor } from "@tiptap/react";

import {
  moveBeatToPosition,
  placeBeatAtEnd,
  unplaceBeat,
} from "@/features/editor/beat/beatOperations";
import {
  useUnplacedBeatsStore,
  type UnplacedBeat,
} from "@/features/editor/beat/unplacedBeatsStore";

interface UseBeatDragDropArgs {
  /** Latest editor instance (mutable ref so the handler always sees current value). */
  editorRef: React.MutableRefObject<Editor | null>;
  /** Scene id used when placing/unplacing beats inside the active document. */
  nodeId: string;
  /** Synchronously rejects drops that finish after the editor projection changed. */
  canMutate?: () => boolean;
  /** Exact input projection token captured at drag start and checked at drop. */
  projectionKeyRef?: React.MutableRefObject<string>;
}

/**
 * Owns the dnd-kit state and handlers for the beat drag-and-drop interactions
 * (unplaced↔unplaced reorder, unplaced→placed, placed→unplaced, placed move).
 *
 * Extracted from EditorPane verbatim — behaviour is unchanged.
 */
export function useBeatDragDrop({
  editorRef,
  nodeId,
  canMutate,
  projectionKeyRef,
}: UseBeatDragDropArgs) {
  const [draggingBeat, setDraggingBeat] = useState<UnplacedBeat | null>(null);
  const dragContextRef = useRef<{
    nodeId: string;
    projectionKey: string | null;
  } | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  // pointerWithin works well for sortable items + outer drop zones; fall back
  // to rectIntersection if the pointer doesn't directly overlap any droppable
  // (e.g. when dragging fast or releasing in a gap between zones).
  const collisionDetection: CollisionDetection = useCallback((args) => {
    const pointerCollisions = pointerWithin(args);
    if (pointerCollisions.length > 0) return pointerCollisions;
    return rectIntersection(args);
  }, []);

  const onDragStart = useCallback(
    (event: DragStartEvent) => {
      if (canMutate && !canMutate()) {
        dragContextRef.current = null;
        return;
      }
      dragContextRef.current = {
        nodeId,
        projectionKey: projectionKeyRef?.current ?? null,
      };
      setDraggingBeat(
        (event.active.data.current?.beat as UnplacedBeat | undefined) ?? null,
      );
    },
    [canMutate, nodeId, projectionKeyRef],
  );

  const onDragEnd = useCallback(
    (event: DragEndEvent) => {
      setDraggingBeat(null);
      const dragContext = dragContextRef.current;
      dragContextRef.current = null;
      if (canMutate && !canMutate()) return;
      if (
        (canMutate || projectionKeyRef) &&
        (!dragContext ||
          dragContext.nodeId !== nodeId ||
          dragContext.projectionKey !== (projectionKeyRef?.current ?? null))
      ) {
        return;
      }
      const { active, over } = event;
      const ed = editorRef.current;

      if (!over) return;

      // Reorder within the unplaced list: over.id is a sibling beat id
      // (sortable items register their own droppable zones).
      if (over.id !== active.id) {
        const draggedBeat = active.data.current?.beat as
          | UnplacedBeat
          | undefined;
        const dragSceneId = active.data.current?.sceneId as string | undefined;
        if (draggedBeat && dragSceneId) {
          const beats = useUnplacedBeatsStore.getState().getBeats(dragSceneId);
          const toIdx = beats.findIndex((b) => b.id === over.id);
          if (toIdx !== -1) {
            const fromIdx = beats.findIndex((b) => b.id === active.id);
            if (fromIdx !== -1 && fromIdx !== toIdx) {
              useUnplacedBeatsStore
                .getState()
                .reorder(dragSceneId, fromIdx, toIdx);
            }
            return;
          }
        }
      }

      // Placed beat → Unplaced drop zone (B-17)
      if (over.id === "unplaced-drop-zone" && ed) {
        const placedBeatId = active.data.current?.placedBeatId as
          | string
          | undefined;
        if (placedBeatId) {
          unplaceBeat(ed, placedBeatId, nodeId);
          return;
        }
      }

      if (over.id === "beat-editor-drop-zone" && ed) {
        // Unplaced beat → place at end
        const beat = active.data.current?.beat as UnplacedBeat | undefined;
        const dragSceneId = active.data.current?.sceneId as string | undefined;
        if (beat && dragSceneId) {
          placeBeatAtEnd(ed, dragSceneId, beat);
          return;
        }
        // Placed beat → move within document via pointer position
        const placedBeatId = active.data.current?.placedBeatId as
          | string
          | undefined;
        if (placedBeatId) {
          const activatorEvent = event.activatorEvent as
            | MouseEvent
            | TouchEvent;
          const startX =
            "clientX" in activatorEvent
              ? activatorEvent.clientX
              : ((activatorEvent as TouchEvent).touches[0]?.clientX ?? 0);
          const startY =
            "clientY" in activatorEvent
              ? activatorEvent.clientY
              : ((activatorEvent as TouchEvent).touches[0]?.clientY ?? 0);
          const finalX = startX + event.delta.x;
          const finalY = startY + event.delta.y;
          const resolved = ed.view.posAtCoords({ left: finalX, top: finalY });
          if (resolved) {
            moveBeatToPosition(ed, placedBeatId, resolved.pos);
          }
        }
      }
    },
    [canMutate, editorRef, nodeId, projectionKeyRef],
  );

  return { sensors, collisionDetection, draggingBeat, onDragStart, onDragEnd };
}

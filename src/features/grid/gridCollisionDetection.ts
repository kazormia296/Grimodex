import { pointerWithin, rectIntersection } from "@dnd-kit/core";
import type { CollisionDetection } from "@dnd-kit/core";

/**
 * Pointer-based collision wins for nested droppables — when the cursor is on
 * a folder card inside a column, the folder card (smaller, closer to pointer)
 * is picked instead of the enclosing column-slot. Falls back to
 * `rectIntersection` for the gutters between columns where the pointer isn't
 * inside any droppable rect (otherwise drops there yield no target).
 *
 * Inter-card gap snap: when the pointer falls into the 8px gap between two
 * cards inside a column, pointerWithin only matches the surrounding
 * column-slot — which would briefly flash the column-level indicator on every
 * boundary crossing. To prevent that flicker, snap to the nearest in-column
 * scene-drop / column-nest whose X span contains the pointer and whose Y is
 * within 20px. The X-span check leaves the column's left/right padding zones
 * (intentional X-axis column reorder territory) untouched.
 *
 * Default `rectIntersection` ranked targets by overlay-area overlap, which
 * with our snap-to-cursor overlay flips between targets across frames and
 * makes the indicator look like it lights up two places at once.
 *
 * 純ロジック（pointerWithin/rectIntersection + 矩形演算）なので合成 args で単体テスト可能。
 * gridCollisionDetection.test.ts 参照。
 */
export const gridCollisionDetection: CollisionDetection = (args) => {
  const pointer = pointerWithin(args);
  if (pointer.length === 0) return rectIntersection(args);

  if (
    pointer.length === 1 &&
    String(pointer[0].id).startsWith("column-slot-") &&
    args.pointerCoordinates
  ) {
    const slotRect = args.droppableRects.get(pointer[0].id);
    if (slotRect) {
      const px = args.pointerCoordinates.x;
      const py = args.pointerCoordinates.y;
      let bestId: (typeof pointer)[0]["id"] | null = null;
      let bestContainer: (typeof args.droppableContainers)[number] | null =
        null;
      let bestDist = Infinity;
      for (const container of args.droppableContainers) {
        const id = String(container.id);
        if (!id.startsWith("scene-drop-") && !id.startsWith("column-nest-")) {
          continue;
        }
        const rect = args.droppableRects.get(container.id);
        if (!rect) continue;
        // Same column (rect lies inside slotRect horizontally)
        if (rect.left < slotRect.left - 2 || rect.right > slotRect.right + 2) {
          continue;
        }
        // Pointer horizontally over this card (excludes the slot's left/right
        // padding zones where column-level reorder is the intended action).
        if (px < rect.left || px > rect.right) continue;
        const yDist = Math.max(0, rect.top - py, py - rect.bottom);
        if (yDist < bestDist) {
          bestDist = yDist;
          bestId = container.id;
          bestContainer = container;
        }
      }
      if (bestId !== null && bestContainer && bestDist < 20) {
        return [
          {
            id: bestId,
            data: { droppableContainer: bestContainer, value: 0 },
          },
        ];
      }
    }
  }

  return pointer;
};

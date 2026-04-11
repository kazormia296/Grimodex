/** Cursor coordinate types and pure helpers extracted for testability. */

import type { EditorView } from "@tiptap/pm/view";

export type Coords = { left: number; top: number; bottom: number };

/**
 * Convert viewport-relative coordinates to container-relative pixel offsets.
 *
 * Returns `{ left, top, height }` ready to assign to `el.style.*`.
 */
export function toContainerRelative(
  coords: Coords,
  containerRect: { left: number; top: number },
): { left: number; top: number; height: number } {
  return {
    left: coords.left - containerRect.left,
    top: coords.top - containerRect.top,
    height: coords.bottom - coords.top,
  };
}

/**
 * Resolve cursor coordinates for the given ProseMirror position.
 *
 * `bias` controls which visual side of a soft-wrap boundary to use:
 *   -1 = line-end side  (End key, ArrowLeft arriving from next line)
 *    1 = line-start side (Home key, ArrowRight arriving on next line)
 *
 * At non-wrap positions both sides produce identical coordinates, so
 * the bias value has no visible effect there.
 */
export function resolveCoords(
  view: EditorView,
  from: number,
  bias: -1 | 1,
): Coords | null {
  try {
    return view.coordsAtPos(from, bias);
  } catch {
    return null;
  }
}

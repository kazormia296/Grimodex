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
 * 1. Normal case: coordsAtPos(from) is unambiguous — use it directly.
 * 2. Wrap boundary: coordsAtPos with side=-1 and side=1 yield different Y
 *    positions.  Consult the DOM Selection to determine which visual side
 *    the browser chose.  Fall back to the line-start side if DOM Selection
 *    is unavailable.
 */
export function resolveCoords(view: EditorView, from: number): Coords | null {
  let lineEndCoords: Coords | null = null;
  let lineStartCoords: Coords | null = null;
  let isWrapPoint = false;

  try {
    lineEndCoords = view.coordsAtPos(from, -1);
    lineStartCoords = view.coordsAtPos(from, 1);
    isWrapPoint = Math.abs(lineEndCoords.top - lineStartCoords.top) > 2;
  } catch {
    // coordsAtPos can throw near inline atom nodes — not a wrap point
  }

  if (isWrapPoint && lineEndCoords && lineStartCoords) {
    const domCoords = getDomSelectionCoords(view);
    if (domCoords) {
      const distToEnd = Math.abs(domCoords.top - lineEndCoords.top);
      const distToStart = Math.abs(domCoords.top - lineStartCoords.top);
      return distToEnd < distToStart ? lineEndCoords : lineStartCoords;
    }
    return lineStartCoords;
  }

  try {
    return view.coordsAtPos(from);
  } catch {
    return null;
  }
}

/** Read caret coordinates from the DOM Selection's client rects. */
export function getDomSelectionCoords(view: EditorView): Coords | null {
  const win = view.dom.ownerDocument.defaultView;
  const domSel = win?.getSelection();
  if (!domSel?.isCollapsed || !domSel.rangeCount) return null;
  const rects = domSel.getRangeAt(0).getClientRects();
  if (!rects.length) return null;
  const r = rects[0];
  return { left: r.left, top: r.top, bottom: r.bottom };
}

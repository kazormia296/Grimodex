export interface EditorStickySurfaceHandle {
  addAtClientPoint: (clientX: number, clientY: number) => void;
}

const SURFACE_SELECTOR = "[data-editor-sticky-surface]";
const handles = new WeakMap<HTMLElement, EditorStickySurfaceHandle>();

export function registerEditorStickySurface(
  element: HTMLElement,
  handle: EditorStickySurfaceHandle,
): () => void {
  handles.set(element, handle);
  return () => {
    if (handles.get(element) === handle) handles.delete(element);
  };
}

function elementForTarget(target: EventTarget | null): Element | null {
  if (typeof Element !== "undefined" && target instanceof Element) {
    return target;
  }
  if (typeof Node !== "undefined" && target instanceof Node) {
    return target.parentElement;
  }
  return null;
}

function registeredClosestSurface(element: Element | null): HTMLElement | null {
  const surface = element?.closest<HTMLElement>(SURFACE_SELECTOR) ?? null;
  return surface && handles.has(surface) ? surface : null;
}

function registeredSurfacesWithin(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(SURFACE_SELECTOR)).filter(
    (surface) => handles.has(surface),
  );
}

function distanceSquaredToSurface(
  surface: HTMLElement,
  clientX: number,
  clientY: number,
): number {
  const rect = surface.getBoundingClientRect();
  const right = Number.isFinite(rect.right) ? rect.right : rect.left + rect.width;
  const bottom = Number.isFinite(rect.bottom)
    ? rect.bottom
    : rect.top + rect.height;
  const dx =
    clientX < rect.left ? rect.left - clientX : Math.max(0, clientX - right);
  const dy =
    clientY < rect.top ? rect.top - clientY : Math.max(0, clientY - bottom);
  return dx * dx + dy * dy;
}

function nearestSurface(
  surfaces: readonly HTMLElement[],
  clientX: number,
  clientY: number,
): HTMLElement | null {
  let nearest: HTMLElement | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const surface of surfaces) {
    const distance = distanceSquaredToSurface(surface, clientX, clientY);
    if (distance < nearestDistance) {
      nearest = surface;
      nearestDistance = distance;
    }
  }
  return nearest;
}

function surfaceForTarget(
  target: EventTarget | null,
  clientX: number,
  clientY: number,
): HTMLElement | null {
  const targetElement = elementForTarget(target);
  const direct = registeredClosestSurface(targetElement);
  if (direct) return direct;

  // The context-menu listener is owned by a wider Editor container than the
  // manuscript column. Walk outward until that container reveals the one
  // registered Surface it owns. In Linear mode an ancestor can own several
  // scene Surfaces, so select the one nearest the original pointer location.
  let ancestor = targetElement;
  while (ancestor) {
    const candidates = registeredSurfacesWithin(ancestor);
    if (candidates.length === 1) return candidates[0] ?? null;
    if (candidates.length > 1) {
      return nearestSurface(candidates, clientX, clientY);
    }
    ancestor = ancestor.parentElement;
  }

  // Defensive fallback for non-Element targets. Callers are already scoped to
  // an Editor context menu, and pointer proximity keeps split/Linear surfaces
  // from receiving an insertion intended for another document.
  const ownerDocument =
    targetElement?.ownerDocument ??
    (typeof document === "undefined" ? null : document);
  if (!ownerDocument) return null;
  return nearestSurface(
    registeredSurfacesWithin(ownerDocument),
    clientX,
    clientY,
  );
}

/** Route the global editor context-menu click to the exact scene surface. */
export function requestEditorStickyAtTarget(
  target: EventTarget | null,
  clientX: number,
  clientY: number,
): boolean {
  const surface = surfaceForTarget(target, clientX, clientY);
  const handle = surface ? handles.get(surface) : undefined;
  if (!handle) return false;
  handle.addAtClientPoint(clientX, clientY);
  return true;
}

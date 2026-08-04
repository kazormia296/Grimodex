export interface EditorStickySurfaceHandle {
  addAtClientPoint: (clientX: number, clientY: number) => void;
}

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

function surfaceForTarget(target: EventTarget | null): HTMLElement | null {
  if (target instanceof HTMLElement) {
    return target.closest<HTMLElement>("[data-editor-sticky-surface]");
  }
  if (target instanceof Node) {
    return (
      target.parentElement?.closest<HTMLElement>(
        "[data-editor-sticky-surface]",
      ) ?? null
    );
  }
  return null;
}

/** Route the global editor context-menu click to the exact scene surface. */
export function requestEditorStickyAtTarget(
  target: EventTarget | null,
  clientX: number,
  clientY: number,
): boolean {
  const surface = surfaceForTarget(target);
  const handle = surface ? handles.get(surface) : undefined;
  if (!handle) return false;
  handle.addAtClientPoint(clientX, clientY);
  return true;
}

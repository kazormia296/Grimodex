export interface EditorStickySurfaceSize {
  width: number;
  height: number;
}

export function ensureEditorStickySurfaceSize(
  measured: EditorStickySurfaceSize,
  minimumWidth: number,
  minimumHeight: number,
): EditorStickySurfaceSize {
  return {
    width: Math.max(measured.width, minimumWidth),
    height: Math.max(measured.height, minimumHeight),
  };
}

export function measureEditorStickySurface(
  surface: Pick<
    HTMLElement,
    | "clientWidth"
    | "clientHeight"
    | "scrollWidth"
    | "scrollHeight"
    | "getBoundingClientRect"
  >,
): EditorStickySurfaceSize {
  const rect = surface.getBoundingClientRect();
  return {
    width: Math.max(1, surface.clientWidth, surface.scrollWidth, rect.width),
    height: Math.max(
      1,
      surface.clientHeight,
      surface.scrollHeight,
      rect.height,
    ),
  };
}

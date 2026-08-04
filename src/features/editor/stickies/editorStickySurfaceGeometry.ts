export interface EditorStickySurfaceSize {
  width: number;
  height: number;
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

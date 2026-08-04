function sanitizeIdPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-");
}

export function createEditorStickyMaskId(
  stickyId: string,
  surfaceInstanceId: string,
): string {
  return `editor-sticky-mask-${sanitizeIdPart(stickyId)}-${sanitizeIdPart(surfaceInstanceId)}`;
}

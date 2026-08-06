import { useEditorStickyStore } from "./editorStickyStore";
import type { EditorSticky } from "./editorStickyTypes";

export async function setEditorStickyColor(
  sticky: EditorSticky,
  paletteId: string,
  colorSlot: number,
): Promise<void> {
  await useEditorStickyStore
    .getState()
    .update(sticky.id, sticky.projectId, sticky.documentKey, {
      paletteId,
      colorSlot,
    });
}

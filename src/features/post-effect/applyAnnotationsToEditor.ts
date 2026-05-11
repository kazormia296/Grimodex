import type { Editor } from "@tiptap/core";
import type { PostEffectAnnotation } from "./types";

/**
 * Applies annotation marks to the TipTap editor as peAnnotation marks.
 * Clears all existing peAnnotation marks first, then re-applies non-dismissed ones.
 * Call this after scene load and after a post-effect run completes.
 */
export function applyAnnotationsToEditor(
  editor: Editor | null,
  annotations: PostEffectAnnotation[],
): void {
  if (!editor) return;
  editor
    .chain()
    .command(({ tr }) => {
      tr.setMeta("programmaticInsert", true);
      tr.setMeta("annotationUpdate", true);
      const schema = tr.doc.type.schema;
      const markType = schema.marks["peAnnotation"];
      if (!markType) return true;
      const docSize = tr.doc.content.size;
      if (docSize > 2) tr.removeMark(1, docSize - 1, markType);
      for (const ann of annotations) {
        if (ann.status === "dismissed") continue;
        if (ann.rangeStart == null || ann.rangeEnd == null) continue;
        const cf = Math.min(ann.rangeStart, docSize);
        const ct = Math.min(ann.rangeEnd, docSize);
        if (cf < ct)
          tr.addMark(
            cf,
            ct,
            markType.create({
              annotationId: ann.id,
              category: ann.category,
              severity: ann.severity ?? "warning",
              status: ann.status,
            }),
          );
      }
      return true;
    })
    .run();
}

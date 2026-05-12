import type { Editor } from "@tiptap/core";
import type { PostEffectAnnotation } from "./types";
import { resolveAnnotationRange } from "./resolveAnnotationRange";
import { ANNOTATION_REBUILD_META } from "./AnnotationPlugin";

/**
 * Applies annotation marks to the TipTap editor as peAnnotation marks.
 * Clears all existing peAnnotation marks first, then re-applies non-dismissed ones.
 * Call this after scene load and after a post-effect run completes.
 *
 * The DB `range_start`/`range_end` stored from a fresh consistency run are byte
 * offsets into the whitespace-normalized plain text (see Rust `find_text_position`),
 * which do NOT line up with ProseMirror positions (especially for Japanese, where
 * 1 char = 3 bytes and paragraph boundaries add PM positions). So we resolve each
 * annotation's true PM range from `textSnapshot` via `resolveAnnotationRange`,
 * treating the stored range as an approximate hint when there are multiple matches.
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
      tr.setMeta(ANNOTATION_REBUILD_META, true);
      const schema = tr.doc.type.schema;
      const markType = schema.marks["peAnnotation"];
      if (!markType) return true;
      const docSize = tr.doc.content.size;
      if (docSize > 2) tr.removeMark(1, docSize - 1, markType);
      for (const ann of annotations) {
        if (ann.status === "dismissed") continue;
        const resolved = resolveAnnotationRange(tr.doc, {
          rangeStart: ann.rangeStart,
          rangeEnd: ann.rangeEnd,
          textSnapshot: ann.textSnapshot,
        });
        if (!resolved) continue;
        tr.addMark(
          resolved.from,
          resolved.to,
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

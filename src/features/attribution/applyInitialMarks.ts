import type { Editor } from "@tiptap/core";

/**
 * Apply initial authorship marks to the entire document content.
 * Used by Codex and Snippet editors to mark AI-generated content
 * when first loading an entry.
 *
 * Skips marking if:
 * - source is "human" or null (no mark needed)
 * - content already contains embedded `data-authorship` spans (already marked)
 * - document is empty
 *
 * Uses `programmaticInsert` meta to prevent AiEditedPlugin from stripping marks.
 */
export function applyInitialAuthorshipMarks(
  editor: Editor,
  source: string | null,
  content: string,
): void {
  if (!source || source === "human") return;
  if (content.includes("data-authorship")) return;

  const authorshipType = editor.schema.marks["authorship"];
  if (!authorshipType) return;

  editor
    .chain()
    .command(({ tr }) => {
      tr.setMeta("programmaticInsert", true);
      const docSize = tr.doc.content.size;
      if (docSize > 2) {
        tr.addMark(
          1,
          docSize - 1,
          authorshipType.create({
            source,
            timestamp: new Date().toISOString(),
          }),
        );
      }
      return true;
    })
    .run();
}

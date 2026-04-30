import type { Editor } from "@tiptap/core";
import type { MentionRole } from "@/features/codex/CodexMentionExtension";

/**
 * Apply a role suggestion to all mention nodes with the given codexId inside
 * the specified sceneBeat. Dispatches a PM transaction and returns true if at
 * least one node was updated.
 */
export function applyRoleSuggestion(
  editor: Editor,
  beatId: string,
  codexId: string,
  newRole: MentionRole,
): boolean {
  const tr = editor.state.tr;
  let updated = false;

  editor.state.doc.descendants((node, pos, parent) => {
    if (node.type.name !== "mention") return true;
    if (!parent || parent.type.name !== "sceneBeat") return true;
    if ((parent.attrs.id as string | undefined) !== beatId) return true;
    if ((node.attrs.id as string | undefined) !== codexId) return true;

    tr.setNodeMarkup(pos, undefined, { ...node.attrs, role: newRole });
    updated = true;
    return true;
  });

  if (!updated) return false;

  editor.view.dispatch(tr);
  return true;
}

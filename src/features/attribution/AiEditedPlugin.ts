import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

export const aiEditedKey = new PluginKey("aiEdited");

/**
 * ProseMirror plugin that automatically reclassifies "ai" marks
 * as "ai-edited" when the user edits text within an AI-attributed range.
 *
 * Detection strategy: on every doc change, scan the regions affected by
 * the transaction steps. If a step touches text that carries an "authorship"
 * mark with source "ai", update the mark to "ai-edited".
 */
export function createAiEditedPlugin(): Plugin {
  return new Plugin({
    key: aiEditedKey,
    appendTransaction(transactions, _oldState, newState) {
      // Only react to transactions that change the doc AND originate
      // from user input (not programmatic inserts).
      const docChanged = transactions.some((tr) => tr.docChanged);
      if (!docChanged) return null;

      // Skip programmatic inserts (chat/snippet insertion)
      const hasProgrammatic = transactions.some(
        (tr) => tr.getMeta("programmaticInsert") === true,
      );
      if (hasProgrammatic) return null;

      const { schema, tr } = newState;
      const authorshipType = schema.marks["authorship"];
      if (!authorshipType) return null;

      let changed = false;

      newState.doc.descendants((node: ProseMirrorNode, pos: number) => {
        if (!node.isText) return;

        const mark = node.marks.find(
          (m) => m.type === authorshipType && m.attrs.source === "ai",
        );
        if (!mark) return;

        // This text node has source:"ai" — check if it was modified
        // by looking at the mapping from old to new positions.
        // We use a simple heuristic: if any transaction step maps
        // overlap with this node range, the text was edited.
        const nodeEnd = pos + node.nodeSize;
        for (const transaction of transactions) {
          if (!transaction.docChanged) continue;
          for (let i = 0; i < transaction.steps.length; i++) {
            const stepMap = transaction.mapping.maps[i];
            let overlaps = false;
            stepMap.forEach((oldStart: number, oldEnd: number) => {
              // Map old range to new positions
              const newStart = transaction.mapping.map(oldStart, -1);
              const newEnd = transaction.mapping.map(oldEnd, 1);
              if (newStart < nodeEnd && newEnd > pos) {
                overlaps = true;
              }
            });
            if (overlaps) {
              const newMark = authorshipType.create({
                ...mark.attrs,
                source: "ai-edited",
              });
              tr.addMark(pos, nodeEnd, newMark);
              changed = true;
              return; // move to next node
            }
          }
        }
      });

      return changed ? tr : null;
    },
  });
}

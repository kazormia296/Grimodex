import { Plugin, PluginKey } from "@tiptap/pm/state";
import { ReplaceStep } from "@tiptap/pm/transform";
import { isHistoryTransaction } from "@tiptap/pm/history";
import { markStart, markEnd } from "@/lib/perfLog";

export const aiEditedKey = new PluginKey("aiEdited");

/**
 * Sources that trigger node splitting when the user inserts text mid-span.
 */
const SPLITTABLE_SOURCES = new Set(["ai", "unknown"]);

/**
 * ProseMirror plugin that splits authorship marks when the user inserts
 * text within an AI or unknown-attributed range.
 *
 * When a user types inside a marked span, the inserted characters become
 * separate unmarked (human) text nodes while the original flanking text
 * retains its mark unchanged.
 *
 * Detection: inspects each transaction's ReplaceStep to find pure
 * insertions (from === to) or replacements (from !== to with content)
 * that land inside a splittable span, then strips the authorship mark
 * from the inserted range via tr.removeMark().
 */
export function createAiEditedPlugin(): Plugin {
  return new Plugin({
    key: aiEditedKey,
    appendTransaction(transactions, oldState, newState) {
      const docChanged = transactions.some((tr) => tr.docChanged);
      if (!docChanged) return null;
      // Undo/redo replays content verbatim from the history stack — the
      // split/no-split decision was already made at original-edit time.
      // Re-running the splitter here would strip ai/unknown marks from
      // re-inserted text (e.g. delete a mid-span char then Ctrl+Z restores it
      // as "human"). Skip history transactions. isHistoryTransaction matches by
      // prosemirror-history's own PluginKey (robust vs the "history$" string).
      if (transactions.some((tr) => isHistoryTransaction(tr))) return null;
      markStart("plugin.aiEdited.appendTransaction");
      try {
        // Skip programmatic inserts (chat/snippet insertion)
        const hasProgrammatic = transactions.some(
          (tr) => tr.getMeta("programmaticInsert") === true,
        );
        if (hasProgrammatic) return null;

        const { schema, tr } = newState;
        const authorshipType = schema.marks["authorship"];
        if (!authorshipType) return null;

        let changed = false;

        for (const transaction of transactions) {
          if (transaction.getMeta("programmaticInsert") === true) continue;

          const steps = transaction.steps;
          for (let i = 0; i < steps.length; i++) {
            const step = steps[i];
            if (!(step instanceof ReplaceStep)) continue;

            const { from } = step as { from: number };
            const insertedSize = step.slice.size;
            if (insertedSize === 0) continue;

            // Check if the insertion/replacement position is inside a splittable span
            // Use oldState positions (step coordinates are in pre-step document)
            let mark = null;
            if (from < oldState.doc.content.size) {
              const $pos = oldState.doc.resolve(from);
              mark = $pos
                .marks()
                .find(
                  (m) =>
                    m.type === authorshipType &&
                    SPLITTABLE_SOURCES.has(m.attrs.source as string) &&
                    !m.attrs.manualOverride,
                );
            }

            if (mark) {
              // Map the insertion range to newState coordinates
              // For multi-step transactions, map through subsequent steps
              let newFrom = from;
              let newTo = from + insertedSize;
              for (let j = i + 1; j < steps.length; j++) {
                const map = steps[j].getMap();
                newFrom = map.map(newFrom, -1);
                newTo = map.map(newTo, 1);
              }

              tr.removeMark(newFrom, newTo, authorshipType);
              changed = true;
            }
          }
        }

        return changed ? tr : null;
      } finally {
        markEnd("plugin.aiEdited.appendTransaction");
      }
    },
  });
}

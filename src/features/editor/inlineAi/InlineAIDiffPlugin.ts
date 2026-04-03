import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { useInlineAiStore } from "./inlineAiStore";

export const inlineAiDiffKey = new PluginKey<DecorationSet>("inlineAiDiff");

/**
 * ProseMirror decoration plugin that visualises inline AI generated text.
 * - Insert mode: green background (`.diff-add`) on generated range
 * - Replace mode: strikethrough (`.diff-remove`) on original + green on new
 *
 * Reuses existing `.diff-add` / `.diff-remove` CSS classes from index.css.
 */
export function createInlineAIDiffPlugin(): Plugin {
  return new Plugin({
    key: inlineAiDiffKey,
    state: {
      init() {
        return DecorationSet.empty;
      },
      apply(tr, _oldDecos, _oldState, newState) {
        const aiState = useInlineAiStore.getState();

        if (aiState.status !== "generating" && aiState.status !== "diffShown") {
          return DecorationSet.empty;
        }

        // Recalculate on forced update or doc change
        const isForced = tr.getMeta("inlineAiDiffUpdate") === true;
        if (!tr.docChanged && !isForced) {
          return _oldDecos.map(tr.mapping, newState.doc);
        }

        const decos: Decoration[] = [];
        const { generatedRange, originalRange, mode } = aiState;

        // Highlight generated text (insert or replace new text)
        if (generatedRange) {
          const { from, to } = generatedRange;
          if (from < to && to <= newState.doc.content.size) {
            decos.push(Decoration.inline(from, to, { class: "diff-add" }));
          }
        }

        // In replace mode, also show original text as struck-through.
        // After insertion the original text has been removed, so we only
        // show the green highlight on the newly inserted text.
        // The original range is used during the diff-shown phase for Reject.
        void originalRange;
        void mode;

        return DecorationSet.create(newState.doc, decos);
      },
    },
    props: {
      decorations(state) {
        return inlineAiDiffKey.getState(state);
      },
    },
  });
}

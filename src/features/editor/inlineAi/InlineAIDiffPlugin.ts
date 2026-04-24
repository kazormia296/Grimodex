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
        const docSize = newState.doc.content.size;

        // 置換モードでは元テキストを残したまま末尾に生成テキストを挿入する
        // 方式に変わったため、originalRange の範囲にも strike-through 装飾を
        // 付ける。Accept で元テキストを削除、Reject で生成テキストを削除する。
        if (mode === "replace" && originalRange) {
          const { from, to } = originalRange;
          if (from < to && to <= docSize) {
            decos.push(Decoration.inline(from, to, { class: "diff-remove" }));
          }
        }

        // Highlight generated text (insert or replace new text)
        if (generatedRange) {
          const { from, to } = generatedRange;
          if (from < to && to <= docSize) {
            decos.push(Decoration.inline(from, to, { class: "diff-add" }));
          }
        }

        return DecorationSet.create(newState.doc, decos);
      },
    },
    props: {
      decorations(state) {
        return inlineAiDiffKey.getState(state);
      },
    },
    /**
     * ストリーミング中はユーザー由来の入力を握りつぶす。
     * - `inlineAiInsert` meta を付けた chunk 挿入は通す
     * - `addToHistory:false` 付きのプログラマティックな tr は通す
     * - `docChanged === false`（選択変更等）は通す（クリック操作は邪魔しない）
     */
    filterTransaction(tr) {
      const aiState = useInlineAiStore.getState();
      if (aiState.status !== "generating") return true;
      if (!tr.docChanged) return true;
      if (tr.getMeta("inlineAiInsert") === true) return true;
      if (tr.getMeta("addToHistory") === false) return true;
      return false;
    },
  });
}

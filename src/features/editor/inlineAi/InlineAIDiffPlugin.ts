import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Editor } from "@tiptap/core";
import { useInlineAiStore } from "./inlineAiStore";

export const inlineAiDiffKey = new PluginKey<DecorationSet>("inlineAiDiff");

/**
 * グローバル単一 store を複数エディタが共有するとき、このプラグインの装飾と
 * 入力ガードを「生成を所有するエディタ」以外で黙らせる。owner 未指定、または
 * store.activeEditor 未設定 (旧経路) のときはゲートしない。
 */
function isForeignEditor(ownerEditor: Editor | undefined): boolean {
  if (!ownerEditor) return false;
  const active = useInlineAiStore.getState().activeEditor;
  return active != null && active !== ownerEditor;
}

/**
 * ProseMirror decoration plugin that visualises inline AI generated text.
 * - Insert mode: green background (`.diff-add`) on generated range
 * - Replace mode: strikethrough (`.diff-remove`) on original + green on new
 *
 * Reuses existing `.diff-add` / `.diff-remove` CSS classes from index.css.
 *
 * @param ownerEditor このプラグインを載せるエディタ。複数エディタが同じ
 *   グローバル store を共有する場合 (linear / split view)、生成中でない側で
 *   他人のセッションの装飾を描いたり入力を握りつぶしたりしないために渡す。
 */
export function createInlineAIDiffPlugin(ownerEditor?: Editor): Plugin {
  return new Plugin({
    key: inlineAiDiffKey,
    state: {
      init() {
        return DecorationSet.empty;
      },
      apply(tr, _oldDecos, _oldState, newState) {
        const aiState = useInlineAiStore.getState();

        if (
          aiState.status !== "generating" &&
          aiState.status !== "diffShown" &&
          aiState.status !== "error"
        ) {
          return DecorationSet.empty;
        }
        // 他エディタのセッション中は装飾しない (別 doc の同一オフセットに
        // 幽霊 diff-add/diff-remove が出るのを防ぐ)。
        if (isForeignEditor(ownerEditor)) {
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
     * 生成中 (generating) と diff 表示中 (diffShown) は owner エディタの **ユーザー
     * 由来の本文編集** を握りつぶす。diffShown でも止めるのは、Accept 待ちの間に
     * 手動入力・ペーストを通すと、autosave 抑止下 (onUpdate が status!==idle で
     * schedule を飛ばす) で未保存のまま溜まり、離脱で喪失するため (= B1)。
     *
     * 通すもの (= プログラマティック / 非破壊):
     * - `docChanged === false`（選択変更・`inlineAiDiffUpdate` 強制更新等）
     * - `inlineAiInsert` meta（AI chunk 挿入。実際は generating 中しか来ない）
     * - `addToHistory:false`（**真にプログラマティックな chunk streaming**: AI / Beat
     *   の逐次挿入。これを止めると Beat 生成が無音で落ちる回帰になる）。
     *
     * 握りつぶすもの: ユーザーのタイプ入力・ペースト・Fix 系 insertContentAt は
     * addToHistory が立つ通常 tr。Fix 系はさらに各ハンドラの guardInlineAiPending()
     * で先に弾く。
     *
     * 補足: peer-pane live sync の `setContent` は addToHistory:false を立てない通常
     * tr なので diffShown 中は **意図的に握りつぶす**。同一シーンを別ペインで開いて
     * いる場合、peer の全文置換は owner の未確定 generatedRange を破壊するため、
     * 適用せず diff を保護する (peer 側は自前 autosave で保存される)。
     *
     * accept/reject は先に reset()→idle してから tr を投げるので status!==pending と
     * なり、この関数の先頭で素通りする。
     */
    filterTransaction(tr) {
      const aiState = useInlineAiStore.getState();
      if (
        aiState.status !== "generating" &&
        aiState.status !== "diffShown" &&
        aiState.status !== "error"
      ) {
        return true;
      }
      // ペンディングなのが「別エディタ」なら、このエディタの入力は握りつぶさない
      // (リニアで隣のシーンへのタイプがサイレントに落ちるのを防ぐ)。
      if (isForeignEditor(ownerEditor)) return true;
      if (!tr.docChanged) return true;
      if (tr.getMeta("inlineAiInsert") === true) return true;
      if (tr.getMeta("addToHistory") === false) return true;
      return false;
    },
  });
}

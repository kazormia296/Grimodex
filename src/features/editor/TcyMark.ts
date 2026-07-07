import { Mark, mergeAttributes } from "@tiptap/core";

/**
 * TcyMark — 縦中横（tate-chu-yoko）を明示的に付与するマーク。
 *
 * ルビ(RubyNode)・傍点(EmphasisDotsMark)と同格の「特殊表現」。選択して
 * バブルメニューでトグル、または青空記法 ［＃縦中横］…［＃縦中横終わり］ の
 * 入力変換(AozoraInputRules)で付与し、doc に永続化される。
 *
 * 縦書き(vertical-rl)では `.tcy` に text-combine-upright が当たり横並び正立で
 * 結合する(CSS: `.editor-vertical .tiptap .tcy`)。横書きでは結合は無意味なので
 * 淡い点線下線で「印が付いている」ことだけ示す。
 *
 * 既存の自動変換(TateChuYokoPlugin の decoration, editor.tateChuYoko off/2/all)
 * とは別系統で併存する。auto は明示マーク済みの run を二重装飾しない
 * (TateChuYokoPlugin 側で rangeHasMark ガード)。エクスポートは applyMarks の
 * `tcy` ケースが縦中横記法を出す(policy 非依存＝明示は常に出力)。
 */
export const TcyMark = Mark.create({
  name: "tcy",

  parseHTML() {
    return [{ tag: "span.tcy" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes({ class: "tcy" }, HTMLAttributes), 0];
  },
});

import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

/**
 * 傍点（圏点）の WebKitGTK 縦書きワークアラウンド decoration プラグイン。
 *
 * WebKitGTK は vertical-rl の native text-emphasis 描画にエンジンバグを持ち、
 * **複数文字の run** ではマークが欠落する（実測: 5 文字 run で 3 マークしか
 * 描かれない。CSS 値の調整では修正不能）。一方、run を 1 文字ずつ別々の
 * span に割ると native が全マークを正しい位置に描く（スクローラ非縦書き化
 * 後の構造で実機ピクセル解析により確認）。
 *
 * そこでこのプラグインは emphasisDots マークの付いた text run を 1 文字
 * （grapheme）ずつ `.emphasis-dot-char` の inline decoration に割るだけを行う。
 * **描画そのものは native text-emphasis (sesame) に任せる** — クラスに視覚
 * スタイルは無い（過去の「native を止めて背景ドットを自前描画する」方式は、
 * ゴマ点の見た目を保てないため廃止。分割 + native が正解の組み合わせ）。
 *
 * 登録は useEmphasisDotsFallback が isWebKitGtk() かつ縦書き時のみ行う。
 * 横書き・Chromium・WKWebView は分割不要（native が run のままでも正しい）。
 */
export const emphasisDotsFallbackKey = new PluginKey<DecorationSet>(
  "emphasisDotsFallback",
);

// grapheme 単位で割る（サロゲートペア・結合文字を分断しない）。
// Intl.Segmenter が無い環境ではコードポイント単位へフォールバック。
const graphemeSegmenter =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter("ja", { granularity: "grapheme" })
    : null;

function* graphemes(text: string): Generator<string> {
  if (graphemeSegmenter) {
    for (const s of graphemeSegmenter.segment(text)) yield s.segment;
  } else {
    yield* text;
  }
}

/** doc 全体を走査して傍点フォールバックの DecorationSet を作る（テストからも使用）。 */
export function buildEmphasisDotsFallbackDecorations(
  doc: ProseMirrorNode,
): DecorationSet {
  const markType = doc.type.schema.marks.emphasisDots;
  if (!markType) return DecorationSet.empty;
  const decos: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return true;
    if (!markType.isInSet(node.marks)) return true;
    let offset = 0;
    for (const ch of graphemes(node.text)) {
      // 空白には傍点を打たない（native text-emphasis と同じ挙動）
      if (!/^\s+$/.test(ch)) {
        decos.push(
          Decoration.inline(pos + offset, pos + offset + ch.length, {
            class: "emphasis-dot-char",
          }),
        );
      }
      offset += ch.length;
    }
    return true;
  });
  return DecorationSet.create(doc, decos);
}

export function createEmphasisDotsFallbackPlugin(): Plugin {
  return new Plugin<DecorationSet>({
    key: emphasisDotsFallbackKey,
    state: {
      init: (_config, state) => buildEmphasisDotsFallbackDecorations(state.doc),
      apply(tr, old) {
        // mark の付け外しは docChanged になるため、docChanged 時は再構築する
        // （map だと新規に付いた傍点 run を取りこぼす）。
        if (tr.docChanged) return buildEmphasisDotsFallbackDecorations(tr.doc);
        return old;
      },
    },
    props: {
      decorations(state) {
        return emphasisDotsFallbackKey.getState(state);
      },
    },
  });
}

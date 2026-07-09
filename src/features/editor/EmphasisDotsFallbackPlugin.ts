import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

/**
 * 傍点（圏点）の WebKitGTK 縦書きフォールバック decoration プラグイン。
 *
 * WebKitGTK は vertical-rl の native text-emphasis 描画にエンジンバグを持つ:
 * 各マークが文字境界側へ半文字ずれ、run 先頭文字のマークは描画されない
 * （CSS 値の調整では修正不能）。そこで WebKitGTK×縦書きに限り native 描画を
 * CSS で止め（index.css: text-emphasis: none）、このプラグインが emphasisDots
 * マークの付いた text run を 1 文字（grapheme）ずつ `.emphasis-dot-char` の
 * inline decoration に割り、CSS が各 span の背景に傍点ドットを描く。
 *
 * ドットを ::after の abspos で描かないのは、WebKitGTK が縦書きで
 * 「inline を包含ブロックとする abspos」の paint を leading 分ズラす別バグを
 * 持つため（ShowInvisibles の空白マークと同じ理由で background 方式に統一。
 * 列間へのはみ出しはブロック軸 padding — 縦書き inline ではレイアウト非干渉 —
 * で確保する）。
 *
 * 登録は useEmphasisDotsFallback が isWebKitGtk() かつ縦書き時のみ行う。
 * 横書き・Chromium・WKWebView は native text-emphasis のまま。
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

import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

/**
 * 空白・改行の可視化 (`editor.showInvisibles`) の Decoration プラグイン。
 *
 * - 半角空白 / 全角空白(U+3000) / タブ → text ノードを走査し1文字ごとに
 *   `Decoration.inline` でクラスを付け、CSS の ::before オーバレイでグリフを重ねる。
 *   実文字はドキュメントに残るためコピー・文字数・往復に影響しない。
 * - hardBreak(`<br>`) / 段落末 ¶ → フロー幅ゼロの `Decoration.widget` + ::before
 *   オーバレイ。旧実装の段落 `::after` ¶ は行末に余白が無いと次行へ折り返し、
 *   幻の改行を生んでいた。widget 化でレイアウトに影響させない。
 *
 * docChanged のたびに丸ごと再構築する (map しない): 全置換(タブ/シーン切替)でも
 * zombie decoration が残らず、新規入力した空白も即座に拾える。設定 OFF 時は
 * `useShowInvisibles` が unregister するので、このプラグインは登録中＝常時 ON でよい。
 */

export const showInvisiblesKey = new PluginKey<DecorationSet>("showInvisibles");

function buildWidgetAnchor(className: string): HTMLElement {
  const span = document.createElement("span");
  span.className = className;
  span.setAttribute("contenteditable", "false");
  return span;
}

function buildBrWidget(): HTMLElement {
  return buildWidgetAnchor("pm-ws pm-ws-br");
}

function buildParaEndWidget(): HTMLElement {
  return buildWidgetAnchor("pm-ws pm-ws-para-end");
}

/** 旧 CSS `.editor-show-invisibles .tiptap > …::after` と同じ対象ブロック。 */
function shouldShowParaEnd(
  node: ProseMirrorNode,
  parent: ProseMirrorNode | null,
): boolean {
  if (!parent) return false;
  if (node.type.name === "heading") {
    const level = node.attrs.level as number;
    return parent.type.name === "doc" && level >= 1 && level <= 3;
  }
  if (node.type.name === "paragraph") {
    return ["doc", "listItem", "blockquote"].includes(parent.type.name);
  }
  return false;
}

/** doc 全体を走査して不可視文字の DecorationSet を作る (テストからも使用)。 */
export function buildInvisibleDecorations(doc: ProseMirrorNode): DecorationSet {
  const decos: Decoration[] = [];
  doc.descendants((node, pos, parent) => {
    if (node.isText && node.text) {
      const text = node.text;
      for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        let cls: string | null = null;
        if (code === 0x20)
          cls = "pm-ws pm-ws-space"; // 半角空白
        else if (code === 0x3000)
          cls = "pm-ws pm-ws-ideographic"; // 全角空白
        else if (code === 0x09) cls = "pm-ws pm-ws-tab"; // タブ
        if (cls) {
          const from = pos + i;
          decos.push(Decoration.inline(from, from + 1, { class: cls }));
        }
      }
      return false;
    }
    if (node.type.name === "hardBreak") {
      decos.push(
        Decoration.widget(pos, buildBrWidget, {
          side: -1,
          key: `ws-br-${pos}`,
        }),
      );
      return false;
    }
    if (shouldShowParaEnd(node, parent)) {
      decos.push(
        Decoration.widget(pos + node.nodeSize - 1, buildParaEndWidget, {
          side: 1,
          key: `ws-para-${pos}`,
        }),
      );
    }
    return true;
  });
  return DecorationSet.create(doc, decos);
}

export function createShowInvisiblesPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: showInvisiblesKey,
    state: {
      init: (_config, state) => buildInvisibleDecorations(state.doc),
      apply: (tr, old, _oldState, newState) =>
        tr.docChanged ? buildInvisibleDecorations(newState.doc) : old,
    },
    props: {
      decorations(state) {
        return showInvisiblesKey.getState(state);
      },
    },
  });
}

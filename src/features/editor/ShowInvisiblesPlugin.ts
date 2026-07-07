import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

/**
 * 空白・改行の可視化 (`editor.showInvisibles`) の Decoration プラグイン。
 *
 * - 半角空白 / 全角空白(U+3000) / タブ → text ノードを走査し1文字ごとに
 *   `Decoration.inline` でクラスを付け、CSS の ::before オーバレイでグリフを重ねる。
 *   実文字はドキュメントに残るためコピー・文字数・往復に影響しない。
 * - hardBreak(`<br>`) → void 要素で CSS ::before が不安定なので `Decoration.widget`
 *   で ↵ グリフを注入する。
 * - 段落末 ¶ はこのプラグインではなく純CSS (`.editor-show-invisibles .tiptap > p::after`)。
 *
 * docChanged のたびに丸ごと再構築する (map しない): 全置換(タブ/シーン切替)でも
 * zombie decoration が残らず、新規入力した空白も即座に拾える。設定 OFF 時は
 * `useShowInvisibles` が unregister するので、このプラグインは登録中＝常時 ON でよい。
 */

export const showInvisiblesKey = new PluginKey<DecorationSet>("showInvisibles");

function buildBrWidget(): HTMLElement {
  const span = document.createElement("span");
  span.className = "pm-ws pm-ws-br";
  span.textContent = "↵";
  span.setAttribute("contenteditable", "false");
  return span;
}

/** doc 全体を走査して不可視文字の DecorationSet を作る (テストからも使用)。 */
export function buildInvisibleDecorations(doc: ProseMirrorNode): DecorationSet {
  const decos: Decoration[] = [];
  doc.descendants((node, pos) => {
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

import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";

export const BRACKET_CLASS = "beat-bracket-instruction";

const BRACKET_RE = /\[[^\[\]]+?\]/g;

const bracketDecoKey = new PluginKey<DecorationSet>("bracketInstruction");

function buildDecorations(doc: PMNode): DecorationSet {
  const decos: Decoration[] = [];

  doc.descendants((node, pos, parent) => {
    // sceneBeat サブツリーのみ対象。generatedProseBlock や通常段落はスキップ。
    if (node.type.name === "generatedProseBlock") return false;
    if (!node.isText) return true;
    if (parent?.type.name !== "sceneBeat") return true;

    const text = node.text ?? "";
    let match: RegExpExecArray | null;
    BRACKET_RE.lastIndex = 0;
    while ((match = BRACKET_RE.exec(text)) !== null) {
      if (match[0].length <= 2) continue; // [] は除外（最低1文字）
      const from = pos + match.index;
      const to = from + match[0].length;
      // spec に class を持たせることでテストからの識別を可能にする
      decos.push(
        Decoration.inline(
          from,
          to,
          { class: BRACKET_CLASS },
          { class: BRACKET_CLASS },
        ),
      );
    }
    return true;
  });

  return DecorationSet.create(doc, decos);
}

export const BracketInstructionDecoration = Extension.create({
  name: "bracketInstructionDecoration",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: bracketDecoKey,
        state: {
          init(_, state) {
            return buildDecorations(state.doc);
          },
          apply(tr, old) {
            if (!tr.docChanged) return old;
            return buildDecorations(tr.doc);
          },
        },
        props: {
          decorations(state) {
            return bracketDecoKey.getState(state);
          },
        },
      }),
    ];
  },
});

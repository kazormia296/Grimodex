import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { shouldApplyAutomaticParagraphIndent } from "@/lib/paragraphIndentPolicy";

export const paragraphIndentPluginKey = new PluginKey<DecorationSet>(
  "paragraphIndentPolicy",
);

/**
 * Return the first user-visible text represented by a node. Unknown leaf nodes
 * count as visible content so an inline atom before dialogue does not
 * accidentally suppress indentation. sceneBeat is display metadata and is
 * skipped, matching exportEngine's paragraph-leading-content handling.
 */
function firstRenderedText(node: ProseMirrorNode): string {
  if (node.isText) return node.text ?? "";
  if (node.type.name === "ruby") return String(node.attrs.base ?? "");
  if (node.type.name === "hardBreak") return "\n";
  if (node.type.name === "sceneBeat") return "";
  if (node.isLeaf) return "\uFFFC";

  for (let index = 0; index < node.childCount; index += 1) {
    const text = firstRenderedText(node.child(index));
    if (text.length > 0) return text;
  }
  return "";
}

/**
 * Add a node decoration to top-level paragraphs whose automatic first-line
 * indentation must be suppressed. Nested paragraphs (lists/quotes) never
 * receive the editor's top-level indent rule and are intentionally ignored.
 */
export function buildParagraphIndentDecorations(
  doc: ProseMirrorNode,
): DecorationSet {
  const decorations: Decoration[] = [];

  doc.forEach((node, offset) => {
    if (node.type.name !== "paragraph") return;
    if (shouldApplyAutomaticParagraphIndent(firstRenderedText(node))) return;

    decorations.push(
      Decoration.node(
        offset,
        offset + node.nodeSize,
        { style: "text-indent: 0" },
        { paragraphIndentSuppressed: true },
      ),
    );
  });

  return DecorationSet.create(doc, decorations);
}

export function createParagraphIndentPlugin(): Plugin {
  return new Plugin({
    key: paragraphIndentPluginKey,
    state: {
      init(_config, state) {
        return buildParagraphIndentDecorations(state.doc);
      },
      apply(transaction, decorations, _oldState, newState) {
        if (!transaction.docChanged) {
          return decorations.map(transaction.mapping, transaction.doc);
        }
        return buildParagraphIndentDecorations(newState.doc);
      },
    },
    props: {
      decorations(state) {
        return paragraphIndentPluginKey.getState(state);
      },
    },
  });
}

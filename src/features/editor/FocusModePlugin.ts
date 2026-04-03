import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

export const focusModeKey = new PluginKey<DecorationSet>("focusMode");

/**
 * Builds decorations that dim all top-level blocks except the one containing
 * the cursor position. Returns DecorationSet.empty when focusMode is false or
 * the document has only one block.
 */
export function buildFocusDimDecorations(
  doc: ProseMirrorNode,
  cursorPos: number,
  focusMode: boolean,
): DecorationSet {
  if (!focusMode) return DecorationSet.empty;

  const decos: Decoration[] = [];
  let currentBlockIndex = -1;
  const blocks: Array<{ pos: number; nodeSize: number; index: number }> = [];

  doc.forEach((node, offset, index) => {
    const start = offset + 1; // inside the block
    const end = offset + node.nodeSize - 1;
    if (cursorPos >= offset && cursorPos <= offset + node.nodeSize) {
      currentBlockIndex = index;
    }
    blocks.push({ pos: offset, nodeSize: node.nodeSize, index });
    void start;
    void end;
  });

  if (blocks.length <= 1) return DecorationSet.empty;

  for (const block of blocks) {
    if (block.index !== currentBlockIndex) {
      decos.push(
        Decoration.node(
          block.pos,
          block.pos + block.nodeSize,
          { class: "focus-dimmed" },
          { class: "focus-dimmed" },
        ),
      );
    }
  }

  return DecorationSet.create(doc, decos);
}

export function createFocusModePlugin(getFocusMode: () => boolean): Plugin {
  return new Plugin({
    key: focusModeKey,
    state: {
      init() {
        return DecorationSet.empty;
      },
      apply(tr, _oldDecos, _oldState, newState) {
        if (
          !tr.docChanged &&
          !tr.selectionSet &&
          tr.getMeta("focusModeUpdate") !== true
        ) {
          return _oldDecos.map(tr.mapping, tr.doc);
        }
        return buildFocusDimDecorations(
          newState.doc,
          newState.selection.from,
          getFocusMode(),
        );
      },
    },
    props: {
      decorations(state) {
        return focusModeKey.getState(state);
      },
    },
  });
}

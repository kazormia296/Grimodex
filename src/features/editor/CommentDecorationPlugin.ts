import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { useCursorSettingsStore } from "./cursorSettingsStore";

export const commentDecorationKey = new PluginKey<DecorationSet>(
  "commentDecoration",
);

/** Meta key to force decoration rebuild (dispatched when showComments toggles). */
export const COMMENT_REBUILD_META = "commentDecoration/rebuild";

function buildDecorations(
  doc: ProseMirrorNode,
  showComments: boolean,
): DecorationSet {
  if (!showComments) return DecorationSet.empty;

  const decos: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText) return;
    for (const mark of node.marks) {
      if (mark.type.name !== "comment") continue;
      decos.push(
        Decoration.inline(pos, pos + node.nodeSize, {
          class: "comment-deco",
          "data-comment-text": (mark.attrs.text as string) ?? "",
          "data-comment-from": String(pos),
          "data-comment-to": String(pos + node.nodeSize),
        }),
      );
    }
  });

  return DecorationSet.create(doc, decos);
}

export function createCommentDecorationPlugin(): Plugin {
  return new Plugin({
    key: commentDecorationKey,

    state: {
      init(_, { doc }) {
        return buildDecorations(
          doc,
          useCursorSettingsStore.getState().showComments,
        );
      },
      apply(tr, set, _oldState, newState) {
        const rebuild =
          tr.getMeta(COMMENT_REBUILD_META) === true || tr.docChanged;
        if (rebuild) {
          return buildDecorations(
            newState.doc,
            useCursorSettingsStore.getState().showComments,
          );
        }
        return set.map(tr.mapping, newState.doc);
      },
    },

    props: {
      decorations(state) {
        return commentDecorationKey.getState(state);
      },
    },
  });
}

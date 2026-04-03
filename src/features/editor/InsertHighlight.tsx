import { useEffect } from "react";
import type { Editor } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { useEditorStore } from "./editorStore";

const insertHighlightKey = new PluginKey("insertHighlight");

function createHighlightPlugin(): Plugin {
  return new Plugin({
    key: insertHighlightKey,
    state: {
      init() {
        return DecorationSet.empty;
      },
      apply(_tr, _oldState, _oldEditorState, newEditorState) {
        const range = useEditorStore.getState().lastInsertRange;
        if (!range) return DecorationSet.empty;

        const { from, to } = range;
        const docSize = newEditorState.doc.content.size;
        if (from >= docSize || to > docSize) return DecorationSet.empty;

        const chatMessageId = range.chatMessageId;
        const cssClass = chatMessageId.startsWith("snippet-")
          ? "insert-highlight-snippet"
          : "insert-highlight";
        const deco = Decoration.inline(from, to, { class: cssClass });
        return DecorationSet.create(newEditorState.doc, [deco]);
      },
    },
    props: {
      decorations(state) {
        return insertHighlightKey.getState(state);
      },
    },
  });
}

export function useInsertHighlight(editor: Editor | null) {
  const lastInsertRange = useEditorStore((s) => s.lastInsertRange);

  useEffect(() => {
    if (!editor) return;

    // Register the plugin once
    const existingPlugin = editor.view.state.plugins.find(
      (p) => p.spec.key === insertHighlightKey,
    );
    if (!existingPlugin) {
      editor.registerPlugin(createHighlightPlugin());
    }

    return () => {
      editor.unregisterPlugin(insertHighlightKey);
    };
  }, [editor]);

  // Force editor to re-render decorations when range changes
  useEffect(() => {
    if (!editor) return;
    // Dispatch an empty transaction to trigger decoration recalculation
    const { tr } = editor.state;
    editor.view.dispatch(tr);
  }, [editor, lastInsertRange]);
}

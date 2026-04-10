import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { useEditorStore } from "./editorStore";

export const ghostPreviewKey = new PluginKey("ghostPreview");

const MAX_PREVIEW_CHARS = 200;

function truncateText(text: string): string {
  if (text.length <= MAX_PREVIEW_CHARS) return text;
  return text.slice(0, MAX_PREVIEW_CHARS) + "...";
}

export function createGhostPreviewPlugin(): Plugin {
  return new Plugin({
    key: ghostPreviewKey,
    state: {
      init() {
        return DecorationSet.empty;
      },
      apply(_tr, _oldState, _oldEditorState, newEditorState) {
        const ghostPreview = useEditorStore.getState().ghostPreview;
        if (!ghostPreview) return DecorationSet.empty;

        const { text, pos } = ghostPreview;
        const docSize = newEditorState.doc.content.size;
        if (pos < 0 || pos > docSize) return DecorationSet.empty;

        const clampedPos = Math.min(pos, docSize);
        const displayText = truncateText(text);

        const deco = Decoration.widget(
          clampedPos,
          () => {
            const span = document.createElement("span");
            span.className = "ghost-preview-text";
            span.textContent = displayText;
            return span;
          },
          { side: 1 },
        );

        return DecorationSet.create(newEditorState.doc, [deco]);
      },
    },
    props: {
      decorations(state) {
        return ghostPreviewKey.getState(state);
      },
    },
  });
}

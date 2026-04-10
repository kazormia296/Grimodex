import { useEffect } from "react";
import type { Editor } from "@tiptap/core";
import {
  ghostPreviewKey,
  createGhostPreviewPlugin,
} from "./GhostPreviewPlugin";
import { useEditorStore } from "./editorStore";

export function useGhostPreview(editor: Editor | null) {
  const ghostPreview = useEditorStore((s) => s.ghostPreview);

  useEffect(() => {
    if (!editor) return;

    // Register the plugin once
    const existingPlugin = editor.view.state.plugins.find(
      (p) => p.spec.key === ghostPreviewKey,
    );
    if (!existingPlugin) {
      editor.registerPlugin(createGhostPreviewPlugin());
    }

    return () => {
      editor.unregisterPlugin(ghostPreviewKey);
    };
  }, [editor]);

  // Force editor to re-render decorations when ghost preview changes
  useEffect(() => {
    if (!editor) return;
    const { tr } = editor.state;
    editor.view.dispatch(tr);
  }, [editor, ghostPreview]);
}

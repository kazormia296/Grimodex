import { useEffect } from "react";
import type { Editor } from "@tiptap/core";
import { useAttributionStore } from "./attributionStore";
import { attributionKey, createAttributionPlugin } from "./AttributionPlugin";

export function useAttribution(editor: Editor | null) {
  const showAttribution = useAttributionStore((s) => s.showAttribution);

  // Register plugin
  useEffect(() => {
    if (!editor) return;
    const existing = editor.view.state.plugins.find(
      (p) => p.spec.key === attributionKey,
    );
    if (!existing) {
      editor.registerPlugin(createAttributionPlugin());
    }
    return () => {
      editor.unregisterPlugin(attributionKey);
    };
  }, [editor]);

  // Force decoration recalculation when toggle changes
  useEffect(() => {
    if (!editor) return;
    const { tr } = editor.state;
    tr.setMeta("attributionUpdate", true);
    editor.view.dispatch(tr);
  }, [editor, showAttribution]);
}

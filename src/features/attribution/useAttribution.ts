import { useEffect } from "react";
import type { Editor } from "@tiptap/core";
import { useAttributionStore } from "./attributionStore";
import { attributionKey, createAttributionPlugin } from "./AttributionPlugin";
import { aiEditedKey, createAiEditedPlugin } from "./AiEditedPlugin";

export function useAttribution(editor: Editor | null) {
  const showAttribution = useAttributionStore((s) => s.showAttribution);
  const filterSource = useAttributionStore((s) => s.filterSource);

  // Register plugins
  useEffect(() => {
    if (!editor) return;
    const hasAttribution = editor.view.state.plugins.find(
      (p) => p.spec.key === attributionKey,
    );
    if (!hasAttribution) {
      editor.registerPlugin(createAttributionPlugin());
    }
    const hasAiEdited = editor.view.state.plugins.find(
      (p) => p.spec.key === aiEditedKey,
    );
    if (!hasAiEdited) {
      editor.registerPlugin(createAiEditedPlugin());
    }
    return () => {
      editor.unregisterPlugin(attributionKey);
      editor.unregisterPlugin(aiEditedKey);
    };
  }, [editor]);

  // Force decoration recalculation when toggle or filter changes
  useEffect(() => {
    if (!editor) return;
    const { tr } = editor.state;
    tr.setMeta("attributionUpdate", true);
    editor.view.dispatch(tr);
  }, [editor, showAttribution]);

  useEffect(() => {
    if (!editor) return;
    const { tr } = editor.state;
    tr.setMeta("attributionUpdate", true);
    editor.view.dispatch(tr);
  }, [editor, filterSource]);
}

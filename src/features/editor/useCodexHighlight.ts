import { useEffect } from "react";
import type { Editor } from "@tiptap/core";
import { useCodexStore } from "@/features/codex/codexStore";
import { useCodexHighlightStore } from "./codexHighlightStore";
import {
  codexHighlightKey,
  createCodexHighlightPlugin,
} from "./CodexHighlightPlugin";

export function useCodexHighlight(editor: Editor | null) {
  const entries = useCodexStore((s) => s.entries);
  const setMatchTargets = useCodexHighlightStore((s) => s.setMatchTargets);
  const enabled = useCodexHighlightStore((s) => s.enabled);

  // Update match targets when codex entries change or highlight is toggled
  useEffect(() => {
    const targets = enabled
      ? entries.map((e) => ({ id: e.id, name: e.name, type: e.type }))
      : [];
    setMatchTargets(targets);
  }, [entries, setMatchTargets, enabled]);

  // Register plugin
  useEffect(() => {
    if (!editor) return;
    const existing = editor.view.state.plugins.find(
      (p) => p.spec.key === codexHighlightKey,
    );
    if (!existing) {
      editor.registerPlugin(createCodexHighlightPlugin());
    }
    return () => {
      editor.unregisterPlugin(codexHighlightKey);
    };
  }, [editor]);

  // Force decoration recalculation when entries change
  useEffect(() => {
    if (!editor) return;
    const { tr } = editor.state;
    tr.setMeta("codexHighlightUpdate", true);
    editor.view.dispatch(tr);
  }, [editor, entries]);
}

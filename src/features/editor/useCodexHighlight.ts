import { useEffect } from "react";
import type { Editor } from "@tiptap/core";
import { useCodexStore } from "@/features/codex/codexStore";
import { listCodexTypes } from "@/features/codex/typeApi";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { useCodexHighlightStore } from "./codexHighlightStore";
import {
  codexHighlightKey,
  createCodexHighlightPlugin,
} from "./CodexHighlightPlugin";

export function useCodexHighlight(editor: Editor | null) {
  const entries = useCodexStore((s) => s.entries);
  const setMatchTargets = useCodexHighlightStore((s) => s.setMatchTargets);
  const setTypeColorMap = useCodexHighlightStore((s) => s.setTypeColorMap);
  const enabled = useCodexHighlightStore((s) => s.enabled);
  const highlightStyle = useSettingsStore((s) =>
    s.get("display.codexHighlightStyle", "color-text"),
  );

  // Load type color map
  useEffect(() => {
    listCodexTypes("default-project").then((types) => {
      const map: Record<string, string> = {};
      for (const t of types) {
        map[t.slug] = t.color;
      }
      setTypeColorMap(map);
      if (editor) {
        const { tr } = editor.state;
        tr.setMeta("codexHighlightUpdate", true);
        editor.view.dispatch(tr);
      }
    });
  }, [entries, enabled, editor, setTypeColorMap]);

  // Update match targets when codex entries change or highlight is toggled
  useEffect(() => {
    const targets = enabled
      ? entries.map((e) => ({
          id: e.id,
          name: e.name,
          type: e.type,
          aliases: e.aliases,
          excludedAliases: e.excludedAliases,
        }))
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

  // Force decoration recalculation when entries or highlight style change
  useEffect(() => {
    if (!editor) return;
    const { tr } = editor.state;
    tr.setMeta("codexHighlightUpdate", true);
    editor.view.dispatch(tr);
  }, [editor, entries, highlightStyle]);
}

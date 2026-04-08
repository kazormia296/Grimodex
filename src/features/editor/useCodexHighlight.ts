import { useEffect } from "react";
import type { Editor } from "@tiptap/core";
import { useCodexStore } from "@/features/codex/codexStore";
import { listCodexTypes } from "@/features/codex/typeApi";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { useWorkspaceStore } from "@/features/workspace/store";
import { useCodexHighlightStore } from "./codexHighlightStore";
import {
  codexHighlightKey,
  createCodexHighlightPlugin,
} from "./CodexHighlightPlugin";
import { resolveCodexColor } from "@/lib/resolveCodexColors";

export function useCodexHighlight(editor: Editor | null) {
  const entries = useCodexStore((s) => s.entries);
  const setMatchTargets = useCodexHighlightStore((s) => s.setMatchTargets);
  const setTypeColorMap = useCodexHighlightStore((s) => s.setTypeColorMap);
  const enabled = useCodexHighlightStore((s) => s.enabled);
  const highlightStyle = useSettingsStore((s) =>
    s.get("display.codexHighlightStyle", "color-text"),
  );
  const colorTheme = useWorkspaceStore((s) => s.globalSettings?.colorTheme);
  const theme = useWorkspaceStore((s) => s.globalSettings?.theme ?? "system");

  // Load type color map (re-resolves when theme or mode changes)
  useEffect(() => {
    const isDark = document.documentElement.classList.contains("dark");
    listCodexTypes("default-project").then((types) => {
      const map: Record<string, ReturnType<typeof resolveCodexColor>> = {};
      for (const t of types) {
        map[t.slug] = resolveCodexColor(
          t.paletteIndex ?? null,
          t.color,
          colorTheme,
          isDark,
        );
      }
      setTypeColorMap(map);
      if (editor) {
        const { tr } = editor.state;
        tr.setMeta("codexHighlightUpdate", true);
        editor.view.dispatch(tr);
      }
    });
  }, [entries, enabled, editor, setTypeColorMap, colorTheme, theme]);

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

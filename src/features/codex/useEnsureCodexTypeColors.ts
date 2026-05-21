import { useEffect } from "react";
import { useCodexHighlightStore } from "@/features/editor/codexHighlightStore";
import { useWorkspaceStore } from "@/features/workspace/store";
import { listCodexTypes } from "@/features/codex/typeApi";
import { resolveCodexColor } from "@/lib/resolveCodexColors";
import { getCurrentProjectId } from "@/features/project/projectStore";

/**
 * Ensure the global typeColorMap is populated.
 *
 * `useCodexHighlight` (editor) is the primary source of truth for this map but
 * only runs when an editor is mounted. Surfaces that show codex type colors
 * without an editor (e.g. Grid panel) call this to guarantee colors resolve
 * even before the editor is opened.
 *
 * Reloads when the active color theme or light/dark mode changes.
 */
export function useEnsureCodexTypeColors() {
  const setTypeColorMap = useCodexHighlightStore((s) => s.setTypeColorMap);
  const colorTheme = useWorkspaceStore((s) => s.globalSettings?.colorTheme);
  const theme = useWorkspaceStore((s) => s.globalSettings?.theme ?? "system");

  useEffect(() => {
    let cancelled = false;
    const isDark =
      theme === "dark"
        ? true
        : theme === "light"
          ? false
          : window.matchMedia("(prefers-color-scheme: dark)").matches;
    listCodexTypes(getCurrentProjectId()).then((types) => {
      if (cancelled) return;
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
    });
    return () => {
      cancelled = true;
    };
  }, [setTypeColorMap, colorTheme, theme]);
}

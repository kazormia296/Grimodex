import { useEffect, useRef } from "react";
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
import { rebuildAndSchedule, scheduleMatch } from "./codexMatchOrchestrator";

export function useCodexHighlight(
  editor: Editor | null,
  excludeEntryIds: string[] = [],
) {
  const entries = useCodexStore((s) => s.entries);
  const setMatchTargets = useCodexHighlightStore((s) => s.setMatchTargets);
  const setMatchedEntryIds = useCodexHighlightStore(
    (s) => s.setMatchedEntryIds,
  );
  const setTypeColorMap = useCodexHighlightStore((s) => s.setTypeColorMap);
  const enabled = useCodexHighlightStore((s) => s.enabled);
  const highlightStyle = useSettingsStore((s) =>
    s.get("display.codexHighlightStyle", "color-text"),
  );
  const colorTheme = useWorkspaceStore((s) => s.globalSettings?.colorTheme);
  const theme = useWorkspaceStore((s) => s.globalSettings?.theme ?? "system");

  // Keep a stable ref to current targets so the transaction callback
  // can access them without being recreated on every render.
  const targetsRef = useRef<
    Array<{
      id: string;
      name: string;
      type: string;
      aliases: (typeof entries)[0]["aliases"];
      excludedAliases: (typeof entries)[0]["excludedAliases"];
    }>
  >([]);
  const excludeRef = useRef(excludeEntryIds);

  // Load type color map (re-resolves when theme or mode changes)
  useEffect(() => {
    // Derive isDark from React state rather than reading the DOM class, because
    // this effect runs before App.tsx's applyTheme effect (child-before-parent
    // order) and would otherwise see the stale class when light/dark is toggled.
    const isDark =
      theme === "dark"
        ? true
        : theme === "light"
          ? false
          : window.matchMedia("(prefers-color-scheme: dark)").matches;
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
      // Re-run the async matcher so codexHighlightResult rebuilds decorations
      // with the updated typeColorMap (fixes stale colors after theme toggle).
      if (editor && !editor.isDestroyed && editor.state) {
        const targets = targetsRef.current;
        if (targets.length > 0) {
          const text = editor.state.doc.textContent;
          scheduleMatch(text, editor, targets, excludeRef.current, 0);
        }
      }
    });
  }, [entries, enabled, editor, setTypeColorMap, colorTheme, theme]);

  // Update match targets + targetsRef when codex entries change or highlight is toggled
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
    targetsRef.current = targets;
    setMatchTargets(targets);
  }, [entries, setMatchTargets, enabled]);

  // Keep excludeRef in sync
  useEffect(() => {
    excludeRef.current = excludeEntryIds;
  }, [excludeEntryIds]);

  // Register plugin
  useEffect(() => {
    if (!editor || editor.isDestroyed || !editor.view?.state) return;
    const existing = editor.view.state.plugins.find(
      (p) => p.spec.key === codexHighlightKey,
    );
    if (!existing) {
      editor.registerPlugin(createCodexHighlightPlugin());
    }
    return () => {
      if (!editor.isDestroyed) editor.unregisterPlugin(codexHighlightKey);
      setMatchedEntryIds([]);
    };
  }, [editor, setMatchedEntryIds]);

  // Rebuild Rust matcher + initial match when entries or highlight style change
  useEffect(() => {
    if (!editor || editor.isDestroyed || !editor.state) return;
    const targets = targetsRef.current;

    if (targets.length === 0) {
      setMatchedEntryIds([]);
      const tr = editor.state.tr.setMeta("codexHighlightResult", []);
      editor.view.dispatch(tr);
      return;
    }

    void rebuildAndSchedule(editor, targets, excludeRef.current);
    const tr = editor.state.tr.setMeta("codexHighlightUpdate", true);
    editor.view.dispatch(tr);
  }, [editor, entries, highlightStyle]);

  // Schedule async match on doc changes only
  useEffect(() => {
    if (!editor || typeof editor.on !== "function") return;
    const handler = ({
      transaction,
    }: {
      transaction: { docChanged: boolean };
    }) => {
      // Skip non-doc-change transactions (e.g. decoration updates from our own dispatch)
      // to avoid the codexHighlightResult dispatch re-triggering another match cycle.
      if (!transaction.docChanged) return;
      if (editor.isDestroyed || !editor.state) return;
      const targets = targetsRef.current;
      if (targets.length === 0) return;
      const text = editor.state.doc.textContent;
      scheduleMatch(text, editor, targets, excludeRef.current);
    };
    editor.on("transaction", handler);
    return () => {
      editor.off("transaction", handler);
    };
  }, [editor]);
}

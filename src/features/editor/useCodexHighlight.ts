import { useEffect, useMemo, useRef } from "react";
import type { Editor } from "@tiptap/core";
import { useCodexStore } from "@/features/codex/codexStore";
import { listCodexTypes } from "@/features/codex/typeApi";
import { getCurrentProjectId } from "@/features/project/projectStore";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { useWorkspaceStore } from "@/features/workspace/store";
import { useCodexHighlightStore } from "./codexHighlightStore";
import {
  codexHighlightKey,
  createCodexHighlightPlugin,
} from "./CodexHighlightPlugin";
import { resolveCodexColor } from "@/lib/resolveCodexColors";
import { rebuildAndSchedule, scheduleMatch } from "./codexMatchOrchestrator";

interface CodexHighlightOptions {
  excludeEntryIds?: string[];
  /** When true, skip updating the global matchedEntryIds (CodexQuick) store.
   *  Visual decorations still apply. Use this for mini-editors in side panels. */
  skipMatchedIds?: boolean;
}

export function useCodexHighlight(
  editor: Editor | null,
  options?: CodexHighlightOptions | string[],
) {
  // Support legacy positional array form: useCodexHighlight(editor, ["id1"])
  const resolvedOptions: CodexHighlightOptions = Array.isArray(options)
    ? { excludeEntryIds: options }
    : (options ?? {});
  // Memoize the `?? []` fallback so the empty-array path keeps a stable
  // reference across renders — without this, the `excludeRef` sync effect
  // below runs every render even when the caller passed nothing.
  const excludeEntryIds = useMemo(
    () => resolvedOptions.excludeEntryIds ?? [],
    [resolvedOptions.excludeEntryIds],
  );
  const skipMatchedIds = resolvedOptions.skipMatchedIds ?? false;
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
  const skipMatchedIdsRef = useRef(skipMatchedIds);

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
    listCodexTypes(getCurrentProjectId()).then((types) => {
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
          scheduleMatch(
            editor,
            targets,
            excludeRef.current,
            0,
            skipMatchedIdsRef.current,
          );
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

  // Keep excludeRef / skipMatchedIdsRef in sync
  useEffect(() => {
    excludeRef.current = excludeEntryIds;
  }, [excludeEntryIds]);

  useEffect(() => {
    skipMatchedIdsRef.current = skipMatchedIds;
  }, [skipMatchedIds]);

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
      if (!skipMatchedIdsRef.current) setMatchedEntryIds([]);
    };
  }, [editor, setMatchedEntryIds]);

  // Rebuild Rust matcher + initial match when entries or highlight style change
  useEffect(() => {
    if (!editor || editor.isDestroyed || !editor.state) return;
    const targets = targetsRef.current;

    if (targets.length === 0) {
      if (!skipMatchedIdsRef.current) setMatchedEntryIds([]);
      const tr = editor.state.tr.setMeta("codexHighlightResult", []);
      editor.view.dispatch(tr);
      return;
    }

    void rebuildAndSchedule(
      editor,
      targets,
      excludeRef.current,
      skipMatchedIdsRef.current,
    );
    const tr = editor.state.tr.setMeta("codexHighlightUpdate", true);
    editor.view.dispatch(tr);
  }, [editor, entries, highlightStyle, skipMatchedIds, setMatchedEntryIds]);

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
      // 全文テキスト抽出は scheduleMatch が debounce 発火時に行う。ここで
      // 同期実行するとキーストロークごとに O(doc) を払うことになる。
      scheduleMatch(
        editor,
        targets,
        excludeRef.current,
        150,
        skipMatchedIdsRef.current,
      );
    };
    editor.on("transaction", handler);
    return () => {
      editor.off("transaction", handler);
    };
  }, [editor]);
}

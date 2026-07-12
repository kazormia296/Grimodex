import { useEffect, useMemo, useRef } from "react";
import type { Editor } from "@tiptap/core";
import { useCodexStore } from "@/features/codex/codexStore";
import { useCurrentProjectId } from "@/features/project/projectStore";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { buildCodexCompletionIndex } from "./codexCompletionIndex";
import {
  codexCompletionKey,
  createCodexCompletionPlugin,
} from "./CodexCompletionPlugin";

/** Register local Codex ghost completion for one independent TipTap editor. */
export function useCodexCompletion(
  editor: Editor | null,
  enabled = true,
): void {
  const settingEnabled = useSettingsStore((s) =>
    s.getBoolean("editor.codexCompletion", true),
  );
  const entries = useCodexStore((s) => s.entries);
  const projectId = useCurrentProjectId();
  const index = useMemo(
    () =>
      buildCodexCompletionIndex(
        entries.map((entry) => ({
          id: entry.id,
          name: entry.name,
          type: entry.type,
          aliases: entry.aliases,
          excludedAliases: entry.excludedAliases,
        })),
      ),
    [entries],
  );
  const indexRef = useRef(index);
  indexRef.current = index;

  const active = enabled && settingEnabled;

  useEffect(() => {
    if (!active) return;
    void useCodexStore.getState().ensureEntriesLoaded();
  }, [active, projectId]);

  useEffect(() => {
    if (!editor || editor.isDestroyed || !active) return;
    editor.registerPlugin(
      createCodexCompletionPlugin(
        () => indexRef.current,
        () => active && editor.isEditable,
      ),
    );
    return () => {
      if (!editor.isDestroyed) editor.unregisterPlugin(codexCompletionKey);
    };
  }, [editor, active]);

  useEffect(() => {
    if (!editor || editor.isDestroyed || !active || !editor.state) return;
    editor.view.dispatch(
      editor.state.tr.setMeta(codexCompletionKey, { type: "refresh" }),
    );
  }, [editor, active, index]);
}

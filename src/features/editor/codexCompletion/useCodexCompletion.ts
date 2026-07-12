import { useEffect, useRef } from "react";
import type { Editor } from "@tiptap/core";
import { useCodexStore } from "@/features/codex/codexStore";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { getSharedCodexCompletionIndex } from "./codexCompletionIndex";
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
  const completionTargets = useCodexStore((s) => s.completionTargets);
  const index = getSharedCodexCompletionIndex(completionTargets);
  const indexRef = useRef(index);
  indexRef.current = index;

  const active = enabled && settingEnabled;

  useEffect(() => {
    if (!editor || editor.isDestroyed || !active) return;
    editor.registerPlugin(
      createCodexCompletionPlugin(
        () => indexRef.current,
        () => active && editor.isEditable,
        () => editor.view.hasFocus(),
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

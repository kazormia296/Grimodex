import { useEffect, useRef } from "react";
import type { Editor } from "@tiptap/react";

import {
  buildOffsetMap,
  type LintBlock as OffsetLintBlock,
} from "@/features/editor/offsetMap";
import {
  lintDecorationKey,
  buildLintDecorations,
} from "@/features/editor/LintDecorationPlugin";
import { useLintStore } from "./lintStore";
import type { LintConfig, WireLintBlock } from "./types";

/**
 * Imperative trigger used when an action must bypass the normal debounce
 * — e.g. right after applying a Fix. Callable from anywhere since the
 * linter state lives in a Zustand store.
 */
export function runLintNow(
  editor: Editor,
  sceneId: string,
  config: LintConfig = {},
): Promise<void> {
  const map = buildOffsetMap(editor.state.doc);
  const blocks = toWire(map.blocks);
  return useLintStore.getState().runLint(sceneId, blocks, config);
}

const DEBOUNCE_MS = 500;

function toWire(blocks: OffsetLintBlock[]): WireLintBlock[] {
  return blocks.map((b) => ({
    id: b.id,
    kind: b.kind,
    text: b.text,
    str_offset_start: b.strOffsetStart,
  }));
}

/**
 * Drive the Linter for the given editor + scene.
 *
 * Hooks into the editor's update event with a 500ms debounce, serialises
 * the current doc into LintBlocks, invokes the Rust `lint_text` command
 * via the store, and pushes the resulting diagnostics into the editor's
 * Lint decoration plugin.
 *
 * Also runs once on mount / scene switch, bypassing the debounce.
 */
export function useLinter(editor: Editor | null, sceneId: string | null): void {
  const diagnostics = useLintStore((s) => s.diagnostics);
  const runLint = useLintStore((s) => s.runLint);
  const setCurrentScene = useLintStore((s) => s.setCurrentScene);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Push diagnostics → editor decorations whenever they change.
  useEffect(() => {
    if (!editor) return;
    const view = editor.view;
    const tr = view.state.tr.setMeta(lintDecorationKey, {
      type: "lintDecoration/set",
      diagnostics,
    });
    view.dispatch(tr);
    // Build a fresh DecorationSet in case the editor was idle during the
    // store update. buildLintDecorations is invoked here only for type
    // retention; the plugin itself rebuilds from the meta payload.
    void buildLintDecorations;
  }, [editor, diagnostics]);

  // Debounced lint driver.
  useEffect(() => {
    if (!editor) return;
    if (!sceneId) {
      // Non-scene tab (codex / snippet) — drop any leftover diagnostics
      // so the panel doesn't keep showing the previous scene's results.
      useLintStore.getState().clear();
      setCurrentScene(null);
      return;
    }

    function schedule(delay: number) {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        if (!editor || !sceneId) return;
        const map = buildOffsetMap(editor.state.doc);
        const blocks = toWire(map.blocks);
        const config: LintConfig = {};
        void runLint(sceneId, blocks, config);
      }, delay);
    }

    setCurrentScene(sceneId);
    // Run immediately on mount / scene switch (bypass debounce).
    schedule(0);

    const onUpdate = ({
      transaction,
    }: {
      transaction: { docChanged: boolean };
    }) => {
      if (!transaction.docChanged) return;
      schedule(DEBOUNCE_MS);
    };
    editor.on("update", onUpdate);
    return () => {
      editor.off("update", onUpdate);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [editor, sceneId, runLint, setCurrentScene]);
}

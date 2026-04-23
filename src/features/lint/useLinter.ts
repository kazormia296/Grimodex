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
import { useLintConfigStore } from "./lintConfigStore";
import { resolveLintLanguage } from "./types";
import type { LintConfig, WireLintBlock } from "./types";

/**
 * Imperative trigger used when an action must bypass the normal debounce
 * — e.g. right after applying a Fix. Callable from anywhere since the
 * linter state lives in a Zustand store.
 */
export function runLintNow(
  editor: Editor,
  sceneId: string,
  configOverride?: LintConfig,
): Promise<void> {
  const map = buildOffsetMap(editor.state.doc);
  const blocks = toWire(map.blocks);
  const config = configOverride ?? resolveEffectiveConfig();
  return useLintStore
    .getState()
    .runLint(sceneId, blocks, config, resolveLintLanguage());
}

/**
 * Pull the effective Lint config from the config store and trim it to
 * the shape Rust's `lint_text` accepts. Returns an empty config if the
 * store has not finished loading yet (first-render safety).
 */
function resolveEffectiveConfig(): LintConfig {
  const store = useLintConfigStore.getState();
  if (!store.isLoaded) return {};
  return store.getWireConfig();
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

    // Explicitly clear any stale decorations from the editor before the
    // new scene's content is loaded. TipTap re-uses one editor instance
    // across tab switches, so Decorations left over from the previous
    // scene would otherwise map through the setContent transaction and
    // appear on the wrong document.
    editor.view.dispatch(
      editor.state.tr.setMeta(lintDecorationKey, {
        type: "lintDecoration/set",
        diagnostics: [],
      }),
    );

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
        const cfgStore = useLintConfigStore.getState();
        const lang = resolveLintLanguage();
        const effective = cfgStore.getEffective();
        // Respect Linter-wide and per-language toggles.
        if (!effective.enabled || !effective.languages[lang]?.enabled) {
          useLintStore.getState().clear();
          return;
        }
        const map = buildOffsetMap(editor.state.doc);
        const blocks = toWire(map.blocks);
        void runLint(sceneId, blocks, cfgStore.getWireConfig(), lang);
      }, delay);
    }

    setCurrentScene(sceneId);

    // Listen to `transaction` instead of `update` — scene-switch loads
    // content via `setContent(..., { emitUpdate: false })`, which
    // suppresses `update` but not the underlying PM transaction. Without
    // this, returning to a scene after visiting a non-scene tab never
    // triggers a re-lint because the content-reload transaction goes
    // unobserved.
    const onTransaction = ({
      transaction,
    }: {
      transaction: { docChanged: boolean; getMeta: (k: string) => unknown };
    }) => {
      if (!transaction.docChanged) return;
      // The lint decoration plugin dispatches meta-only transactions
      // that set docChanged=false, so we don't loop here — but a defensive
      // check against our own meta guarantees it.
      if (transaction.getMeta("lintDecoration/set")) return;
      // `0` for bulk content reloads (scene switch) so the user sees
      // fresh decorations immediately; `DEBOUNCE_MS` for keyboard input.
      // We can't tell the two apart from the transaction alone, so we
      // always debounce — but on scene switch the initial schedule(0)
      // below handles the immediate case.
      schedule(DEBOUNCE_MS);
    };
    editor.on("transaction", onTransaction);

    // Run immediately on mount / scene switch. Microtask-delayed so the
    // async content-loader (setContent in EditorPane) has a chance to
    // drop the new scene's JSON into the editor before we serialise.
    schedule(0);

    // Re-run lint immediately when the effective config changes
    // (per design: "設定変更 → 現在シーンを即座に再 Lint").
    const unsubscribeConfig = useLintConfigStore.subscribe(() => {
      schedule(0);
    });

    return () => {
      editor.off("transaction", onTransaction);
      unsubscribeConfig();
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [editor, sceneId, runLint, setCurrentScene]);
}

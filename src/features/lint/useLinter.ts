import { useEffect, useRef } from "react";
import type { Editor } from "@tiptap/react";

import {
  buildOffsetMap,
  pmPosToStrOffset,
  strOffsetToPmPos,
  type LintBlock as OffsetLintBlock,
} from "@/features/editor/offsetMap";
import {
  lintDecorationKey,
  buildLintDecorations,
} from "@/features/editor/LintDecorationPlugin";
import { useLintStore } from "./lintStore";
import { useLintIgnoreStore } from "./lintIgnoreStore";
import { useLintProjectStore } from "./lintProjectStore";
import { useLintConfigStore } from "./lintConfigStore";
import { resolveLintLanguage } from "./types";
import type { LintCodexEntry, LintConfig, WireLintBlock } from "./types";
import { listCodexEntries } from "@/features/codex/api";

/**
 * Imperative trigger used when an action must bypass the normal debounce
 * — e.g. right after applying a Fix. Callable from anywhere since the
 * linter state lives in a Zustand store.
 */
export async function runLintNow(
  editor: Editor,
  sceneId: string,
  configOverride?: LintConfig,
): Promise<void> {
  const map = buildOffsetMap(editor.state.doc);
  const blocks = toWire(map.blocks);
  const sceneText = map.blocks.map((b) => b.text).join("\n");
  const config = configOverride ?? resolveEffectiveConfig();
  // Mirror the debounced path: attach Codex entries when the
  // name-inconsistency rule is enabled.
  if (!configOverride) {
    const eff = useLintConfigStore.getState().getEffective();
    const codexRule = eff.rules["codex/name-inconsistency"];
    if (codexRule && codexRule.enabled !== false) {
      (config as LintConfig).codex_entries = await fetchCodexEntriesForLint();
    }
  }
  return useLintStore
    .getState()
    .runLint(sceneId, blocks, config, resolveLintLanguage(), sceneText, []);
}

/**
 * Pull the effective Lint config from the config store and trim it to
 * the shape Rust's `lint_text` accepts. Returns an empty config if the
 * store has not finished loading yet (first-render safety).
 *
 * Codex entries are attached separately by the caller when the
 * `codex/name-inconsistency` rule is enabled (see `fetchCodexEntries`).
 */
function resolveEffectiveConfig(): LintConfig {
  const store = useLintConfigStore.getState();
  if (!store.isLoaded) return {};
  return store.getWireConfig();
}

/**
 * Load Codex entries from the project DB and flatten into the wire
 * shape expected by Rust. Returns `[]` when the rule is disabled or
 * nothing is loaded — cheap no-op for the engine either way.
 *
 * Failures (e.g. DB closed during shutdown) return `[]` silently;
 * losing Codex data for a single lint pass is preferable to crashing
 * the pipeline.
 */
async function fetchCodexEntriesForLint(): Promise<LintCodexEntry[]> {
  try {
    const rows = await listCodexEntries();
    const out: LintCodexEntry[] = [];
    for (const r of rows) {
      if (!r.name || !r.name.trim()) continue;
      let aliases: string[] = [];
      if (r.aliases) {
        try {
          const parsed = JSON.parse(r.aliases);
          if (Array.isArray(parsed)) {
            aliases = parsed.filter(
              (x): x is string => typeof x === "string" && x.length > 0,
            );
          }
        } catch {
          // Stored JSON corruption — skip this entry's aliases only.
        }
      }
      // Include the canonical itself as a no-op alias position; the
      // Rust rule filters out matches equal to canonical. This lets
      // the engine build a single matcher without extra bookkeeping.
      out.push({
        entry_id: r.id,
        canonical: r.name,
        aliases,
      });
    }
    return out;
  } catch {
    return [];
  }
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
      timerRef.current = setTimeout(async () => {
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
        const sceneText = map.blocks.map((b) => b.text).join("\n");
        const wire = cfgStore.getWireConfig();
        // Fetch Codex entries only if a Codex-linked rule is enabled —
        // keeps the hot path free of a DB hit when users aren't using
        // F-group rules.
        const codexRule = effective.rules["codex/name-inconsistency"];
        if (codexRule && codexRule.enabled !== false) {
          const codex_entries = await fetchCodexEntriesForLint();
          (wire as LintConfig).codex_entries = codex_entries;
        }
        // Phase 3 Commit D wires real inline-disable directives here.
        // Until then we ship an empty array so the backend filter is a
        // no-op and existing behaviour stays identical.
        void runLint(sceneId, blocks, wire, lang, sceneText, []);
      }, delay);
    }

    setCurrentScene(sceneId);

    // Kick off loading persistent-ignore entries for this scene. When it
    // resolves we re-apply the filter against the current rawDiagnostics.
    void useLintIgnoreStore
      .getState()
      .loadScene(sceneId)
      .then(() => {
        useLintStore.getState().reapplyIgnores(sceneId);
      })
      .catch(() => {
        /* ignore — load failures leave filter as no-op */
      });

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
      // Pending project-mode jump, if any.
      tryJump();
    };
    editor.on("transaction", onTransaction);

    // Track cursor position → scene offset for reverse highlight.
    const onSelectionUpdate = () => {
      if (!editor) return;
      const map = buildOffsetMap(editor.state.doc);
      const head = editor.state.selection.head;
      const off = pmPosToStrOffset(map, head);
      useLintStore.getState().setCursorOffset(off);
    };
    editor.on("selectionUpdate", onSelectionUpdate);
    onSelectionUpdate();

    // Run immediately on mount / scene switch. Microtask-delayed so the
    // async content-loader (setContent in EditorPane) has a chance to
    // drop the new scene's JSON into the editor before we serialise.
    schedule(0);

    // If a project-mode diagnostic click asked us to jump to this
    // scene, defer until the EditorPane's async setContent fires.
    // We watch for a single `create`-like transaction (docChanged +
    // doc size > 2) and attempt the jump once. If the doc is already
    // loaded, the first pending-jump check below succeeds immediately.
    let jumpAttempted = false;
    const tryJump = () => {
      if (jumpAttempted || !editor || !sceneId) return false;
      const jump = useLintProjectStore.getState().consumeJump(sceneId);
      if (!jump) {
        jumpAttempted = true; // nothing to do
        return false;
      }
      const map = buildOffsetMap(editor.state.doc);
      if (map.totalLength < jump.range.end) {
        // Content not loaded yet — retry on next transaction.
        useLintProjectStore.getState().requestJump(jump);
        return false;
      }
      const from = strOffsetToPmPos(map, jump.range.start);
      const to = strOffsetToPmPos(map, jump.range.end);
      if (from == null || to == null) {
        jumpAttempted = true;
        return false;
      }
      editor
        .chain()
        .focus()
        .setTextSelection({ from, to })
        .scrollIntoView()
        .run();
      jumpAttempted = true;
      return true;
    };
    // First attempt: content may already be loaded (e.g. switching
    // back to a scene whose editor is still warm).
    queueMicrotask(tryJump);

    // Re-run lint immediately when the effective config changes
    // (per design: "設定変更 → 現在シーンを即座に再 Lint").
    const unsubscribeConfig = useLintConfigStore.subscribe(() => {
      schedule(0);
    });

    return () => {
      editor.off("transaction", onTransaction);
      editor.off("selectionUpdate", onSelectionUpdate);
      unsubscribeConfig();
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [editor, sceneId, runLint, setCurrentScene]);
}

import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

import type { Diagnostic, Severity } from "@/features/lint/types";
import { buildOffsetMap, strOffsetToPmPos } from "./offsetMap";
import { useCursorSettingsStore } from "./cursorSettingsStore";

export interface LintDecorationState {
  /**
   * Last diagnostics payload. Kept so the layer toggle can re-materialise
   * decorations without waiting for the next lint debounce. Ranges are
   * NOT mapped through edits — they may be slightly stale when the toggle
   * flips right after typing, and the next lint run corrects them.
   */
  diagnostics: Diagnostic[];
  decos: DecorationSet;
}

export const lintDecorationKey = new PluginKey<LintDecorationState>(
  "lintDecoration",
);

const META_SET = "lintDecoration/set";

/** Meta key to force decoration rebuild (dispatched when showLint toggles). */
export const LINT_REBUILD_META = "lintDecoration/rebuild";

/**
 * Produce a DecorationSet for the given diagnostics. Ranges are translated
 * from scene-wide UTF-16 offsets into ProseMirror positions via the shared
 * offset map.
 */
export function buildLintDecorations(
  doc: ProseMirrorNode,
  diagnostics: Diagnostic[],
): DecorationSet {
  if (diagnostics.length === 0) return DecorationSet.empty;

  const map = buildOffsetMap(doc);
  const decos: Decoration[] = [];

  // When multiple diagnostics overlap, only the most severe one draws an
  // underline. Severity precedence: error > warning > info.
  const byRange = new Map<string, Diagnostic>();
  for (const d of diagnostics) {
    const key = `${d.range.start}-${d.range.end}`;
    const existing = byRange.get(key);
    if (
      !existing ||
      severityRank(d.severity) > severityRank(existing.severity)
    ) {
      byRange.set(key, d);
    }
  }

  for (const d of byRange.values()) {
    const from = strOffsetToPmPos(map, d.range.start);
    const to = strOffsetToPmPos(map, d.range.end);
    if (from == null || to == null) continue;
    if (to <= from) continue;
    decos.push(
      Decoration.inline(from, to, {
        class: `lint-deco lint-deco--${d.severity}`,
        "data-lint-rule": d.rule_id,
        "data-lint-severity": d.severity,
      }),
    );
  }

  return DecorationSet.create(doc, decos);
}

/**
 * True when the transaction contains at least one step that replaces the
 * entire document contents (positions 0..docSize). Such transactions
 * indicate a `setContent` — tab-switch reloads use this pattern — and
 * mapping Lint decorations through them produces garbage, so we clear
 * instead.
 */
function isWholeDocReplacement(
  tr: { steps: readonly unknown[] },
  oldDocSize: number,
): boolean {
  if (tr.steps.length === 0) return false;
  for (const step of tr.steps) {
    const s = step as { from?: number; to?: number };
    if (s.from === 0 && s.to === oldDocSize) return true;
  }
  return false;
}

function severityRank(s: Severity): number {
  switch (s) {
    case "error":
      return 3;
    case "warning":
      return 2;
    case "info":
      return 1;
  }
}

/**
 * Dispatch an updated diagnostic list to the editor. The plugin rebuilds
 * decorations from the new list and the current doc.
 */
export function setLintDiagnostics(
  view: {
    state: { tr: { setMeta: (k: unknown, v: unknown) => unknown } };
    dispatch: (tr: unknown) => void;
  },
  diagnostics: Diagnostic[],
) {
  const tr = (
    view.state.tr as unknown as {
      setMeta: (k: unknown, v: unknown) => unknown;
    }
  ).setMeta(lintDecorationKey, { type: META_SET, diagnostics });
  view.dispatch(tr);
}

export function createLintDecorationPlugin(): Plugin {
  const showLint = () => useCursorSettingsStore.getState().showLint;

  return new Plugin<LintDecorationState>({
    key: lintDecorationKey,
    state: {
      init() {
        return { diagnostics: [], decos: DecorationSet.empty };
      },
      apply(tr, old, oldState, newState) {
        const meta = tr.getMeta(lintDecorationKey) as
          | { type: string; diagnostics?: Diagnostic[] }
          | undefined;
        if (meta && meta.type === META_SET) {
          const diagnostics = meta.diagnostics ?? [];
          return {
            diagnostics,
            decos: showLint()
              ? buildLintDecorations(newState.doc, diagnostics)
              : DecorationSet.empty,
          };
        }
        if (tr.getMeta(LINT_REBUILD_META) === true) {
          return {
            diagnostics: old.diagnostics,
            decos: showLint()
              ? buildLintDecorations(newState.doc, old.diagnostics)
              : DecorationSet.empty,
          };
        }
        if (tr.docChanged) {
          // Detect whole-doc replacements (TipTap `setContent` used when
          // a tab switches scenes). Carrying decorations through the
          // mapping in that case leaves zombie decorations visible on
          // the next document's content, which is visually wrong.
          if (isWholeDocReplacement(tr, oldState.doc.content.size)) {
            return { diagnostics: [], decos: DecorationSet.empty };
          }
          // Small edits (typing, paste): map decorations through the
          // transaction so they stay put until the next lint debounce
          // refreshes them.
          return {
            diagnostics: old.diagnostics,
            decos: old.decos.map(tr.mapping, tr.doc),
          };
        }
        return old;
      },
    },
    props: {
      decorations(state) {
        return lintDecorationKey.getState(state)?.decos;
      },
    },
  });
}

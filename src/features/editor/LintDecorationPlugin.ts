import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

import type { Diagnostic, Severity } from "@/features/lint/types";
import { buildOffsetMap, strOffsetToPmPos } from "./offsetMap";

export const lintDecorationKey = new PluginKey<DecorationSet>("lintDecoration");

const META_SET = "lintDecoration/set";

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
  return new Plugin<DecorationSet>({
    key: lintDecorationKey,
    state: {
      init() {
        return DecorationSet.empty;
      },
      apply(tr, oldDecos, _oldState, newState) {
        const meta = tr.getMeta(lintDecorationKey) as
          | { type: string; diagnostics?: Diagnostic[] }
          | undefined;
        if (meta && meta.type === META_SET) {
          return buildLintDecorations(newState.doc, meta.diagnostics ?? []);
        }
        if (tr.docChanged) {
          // Cheap-first: map existing decorations. Callers will refresh
          // with new diagnostics after the debounce anyway.
          return oldDecos.map(tr.mapping, tr.doc);
        }
        return oldDecos;
      },
    },
    props: {
      decorations(state) {
        return lintDecorationKey.getState(state);
      },
    },
  });
}

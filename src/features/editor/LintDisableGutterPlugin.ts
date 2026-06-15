import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { EditorState, Transaction } from "@tiptap/pm/state";

import { sanitiseRules } from "@/features/lint/lintDisableWalker";
import i18next from "@/lib/i18n";

/**
 * Gutter icon for blocks that contain at least one disable directive
 * (either a `lintDisabled` block attribute or a `lintDisable` Mark on
 * one of the inline children).
 *
 * Per design doc §「視覚的表示」:
 * > ガター（行頭）に小さなアイコン「この行に disable あり」
 *
 * Implementation:
 * - Walk the doc on init / docChanged, collect block positions that have
 *   a directive, and emit a single `widget` decoration at each block
 *   start. The widget is a tiny dot rendered to the left of the block
 *   via CSS positioning (the editor stylesheet handles the geometry).
 * - Skipping the walk when nothing changed keeps the cost negligible
 *   even on large docs (5000+ chars) — a typical scene has <50 blocks.
 */
export const lintDisableGutterKey = new PluginKey<DecorationSet>(
  "lintDisableGutter",
);

const DISABLE_BLOCK_KINDS = new Set([
  "paragraph",
  "heading",
  "blockquote",
  "listItem",
  "tableCell",
]);

interface DisableInfo {
  /** True when the block is silenced wholesale (`["*"]`). */
  isAll: boolean;
  /** Number of distinct directives the block carries. */
  count: number;
}

function blockHasMarkDisable(node: import("@tiptap/pm/model").Node): {
  hasMark: boolean;
  markIsAll: boolean;
} {
  let hasMark = false;
  let markIsAll = false;
  node.descendants((child) => {
    if (hasMark && markIsAll) return false; // early exit
    for (const m of child.marks) {
      if (m.type.name !== "lintDisable") continue;
      const rules = sanitiseRules(m.attrs.rules);
      if (!rules) continue;
      hasMark = true;
      if (rules.length === 1 && rules[0] === "*") markIsAll = true;
    }
    return true;
  });
  return { hasMark, markIsAll };
}

function buildGutterDecorations(state: EditorState): DecorationSet {
  const decos: Decoration[] = [];
  state.doc.descendants((node, pos) => {
    if (!DISABLE_BLOCK_KINDS.has(node.type.name)) return true;

    const blockAttr = sanitiseRules(node.attrs.lintDisabled);
    const blockIsAll =
      !!blockAttr && blockAttr.length === 1 && blockAttr[0] === "*";
    const { hasMark, markIsAll } = blockHasMarkDisable(node);

    if (!blockAttr && !hasMark) return false; // no disables → skip subtree

    const info: DisableInfo = {
      isAll: blockIsAll || markIsAll,
      count: (blockAttr ? 1 : 0) + (hasMark ? 1 : 0),
    };

    decos.push(
      Decoration.widget(
        pos + 1,
        () => {
          const el = document.createElement("span");
          el.className = `lint-disable-gutter${info.isAll ? " lint-disable-gutter--all" : ""}`;
          el.setAttribute("aria-hidden", "true");
          el.title = info.isAll
            ? i18next.t("editor.lintDisable.gutterTooltipAll")
            : i18next.t("editor.lintDisable.gutterTooltipPartial", {
                count: info.count,
              });
          return el;
        },
        { side: -1, key: `lint-gutter-${pos}-${info.isAll ? "all" : "rules"}` },
      ),
    );
    // Block disables can have nested lists (listItem inside listItem),
    // but each one carries its own attr — descend so we can decorate
    // them independently.
    return true;
  });
  return DecorationSet.create(state.doc, decos);
}

/**
 * True when the transaction touches at least one disable-relevant attr
 * or mark. Computing decorations on every keystroke is wasteful — most
 * edits don't change disable coverage.
 */
function transactionAffectsDisables(tr: Transaction): boolean {
  if (!tr.docChanged) return false;
  // Cheap conservative check: any attr / mark step or any change in size.
  // A precise diff would require walking the steps; given the typical
  // disable density (handful per scene), the recomputation is cheap
  // enough that "any docChange" is fine.
  return true;
}

export function createLintDisableGutterPlugin(): Plugin {
  return new Plugin<DecorationSet>({
    key: lintDisableGutterKey,
    state: {
      init(_config, state) {
        return buildGutterDecorations(state);
      },
      apply(tr, oldDecos, _oldState, newState) {
        if (!transactionAffectsDisables(tr)) {
          return oldDecos.map(tr.mapping, tr.doc);
        }
        return buildGutterDecorations(newState);
      },
    },
    props: {
      decorations(state) {
        return lintDisableGutterKey.getState(state);
      },
    },
  });
}

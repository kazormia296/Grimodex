import { describe, it, expect, beforeEach } from "vitest";
import { EditorState } from "@tiptap/pm/state";
import { schema } from "prosemirror-schema-basic";
import { DecorationSet } from "@tiptap/pm/view";

import type { Diagnostic } from "@/features/lint/types";
import { useCursorSettingsStore } from "./cursorSettingsStore";
import {
  createLintDecorationPlugin,
  lintDecorationKey,
  LINT_REBUILD_META,
} from "./LintDecorationPlugin";

function docState(...paragraphs: string[]): EditorState {
  return EditorState.create({
    doc: schema.nodes.doc.create(
      {},
      paragraphs.map((text) =>
        schema.nodes.paragraph.create({}, [schema.text(text)]),
      ),
    ),
    plugins: [createLintDecorationPlugin()],
  });
}

function diag(
  rule_id: string,
  severity: "error" | "warning" | "info",
  start: number,
  end: number,
): Diagnostic {
  return {
    rule_id,
    severity,
    message: "",
    range: { start, end },
  };
}

function getDecoSet(state: EditorState): DecorationSet {
  return (lintDecorationKey.getState(state) as { decos: DecorationSet }).decos;
}

function getDecoRuleIds(state: EditorState): string[] {
  return getDecoSet(state)
    .find()
    .map(
      (deco) =>
        (
          deco as unknown as {
            type: { attrs: Record<string, string> };
          }
        ).type.attrs["data-lint-rule"],
    );
}

beforeEach(() => {
  useCursorSettingsStore.setState({ showLint: true });
});

describe("LintDecorationPlugin", () => {
  it("starts with an empty decoration set", () => {
    const state = docState("hello");
    expect(getDecoSet(state).find()).toHaveLength(0);
  });

  it("sets decorations via meta payload", () => {
    let state = docState("ああ、、いいうう");
    const tr = state.tr.setMeta(lintDecorationKey, {
      type: "lintDecoration/set",
      diagnostics: [diag("ja/consecutive-punct", "error", 2, 4)],
    });
    state = state.apply(tr);
    const decos = getDecoSet(state).find();
    expect(decos).toHaveLength(1);
    // Scene offset 2 → PM pos 3 inside a single paragraph (doc open + "ああ").
    expect(decos[0].from).toBe(3);
    expect(decos[0].to).toBe(5);
  });

  it("higher severity wins for overlapping ranges on same bounds", () => {
    let state = docState("hello");
    const tr = state.tr.setMeta(lintDecorationKey, {
      type: "lintDecoration/set",
      diagnostics: [
        diag("a/info", "info", 0, 5),
        diag("b/error", "error", 0, 5),
      ],
    });
    state = state.apply(tr);
    const decos = getDecoSet(state).find();
    expect(decos).toHaveLength(1);
    // `attrs` lives on the internal InlineType. Cast through the
    // documented escape hatch rather than depend on library internals.
    const decoAny = decos[0] as unknown as {
      type: { attrs: Record<string, string> };
    };
    expect(decoAny.type.attrs.class).toContain("lint-deco--error");
  });

  it("clears on whole-doc replacement (setContent)", () => {
    // Seed a state with a decoration.
    let state = docState("ああ、、いい");
    state = state.apply(
      state.tr.setMeta(lintDecorationKey, {
        type: "lintDecoration/set",
        diagnostics: [diag("ja/consecutive-punct", "error", 2, 4)],
      }),
    );
    expect(getDecoSet(state).find()).toHaveLength(1);

    // Replace the entire document (mimics TipTap setContent).
    const newDoc = schema.nodes.doc.create({}, [
      schema.nodes.paragraph.create({}, [schema.text("codex entry text")]),
    ]);
    const tr = state.tr.replaceWith(0, state.doc.content.size, newDoc.content);
    state = state.apply(tr);

    // Decoration must be gone: mapping through a whole-doc replacement
    // would otherwise place stale underlines on unrelated content.
    expect(getDecoSet(state).find()).toHaveLength(0);
  });

  it("clears on empty payload", () => {
    let state = docState("hello");
    state = state.apply(
      state.tr.setMeta(lintDecorationKey, {
        type: "lintDecoration/set",
        diagnostics: [diag("x", "error", 0, 3)],
      }),
    );
    expect(getDecoSet(state).find()).toHaveLength(1);
    state = state.apply(
      state.tr.setMeta(lintDecorationKey, {
        type: "lintDecoration/set",
        diagnostics: [],
      }),
    );
    expect(getDecoSet(state).find()).toHaveLength(0);
  });

  it("stays empty while showLint is off", () => {
    useCursorSettingsStore.setState({ showLint: false });
    let state = docState("hello");
    state = state.apply(
      state.tr.setMeta(lintDecorationKey, {
        type: "lintDecoration/set",
        diagnostics: [diag("x", "error", 0, 3)],
      }),
    );
    expect(getDecoSet(state).find()).toHaveLength(0);
  });

  it("rebuilds retained diagnostics when toggled back on via LINT_REBUILD_META", () => {
    useCursorSettingsStore.setState({ showLint: false });
    let state = docState("hello");
    state = state.apply(
      state.tr.setMeta(lintDecorationKey, {
        type: "lintDecoration/set",
        diagnostics: [diag("x", "error", 0, 3)],
      }),
    );
    expect(getDecoSet(state).find()).toHaveLength(0);

    useCursorSettingsStore.setState({ showLint: true });
    state = state.apply(state.tr.setMeta(LINT_REBUILD_META, true));
    expect(getDecoSet(state).find()).toHaveLength(1);
  });

  it("hides existing decorations when toggled off via LINT_REBUILD_META", () => {
    let state = docState("hello");
    state = state.apply(
      state.tr.setMeta(lintDecorationKey, {
        type: "lintDecoration/set",
        diagnostics: [diag("x", "warning", 0, 3)],
      }),
    );
    expect(getDecoSet(state).find()).toHaveLength(1);

    useCursorSettingsStore.setState({ showLint: false });
    state = state.apply(state.tr.setMeta(LINT_REBUILD_META, true));
    expect(getDecoSet(state).find()).toHaveLength(0);
  });

  it("drops only stale decorations in the textblock touched by a single inline edit", () => {
    let state = docState("alpha", "bravo");
    state = state.apply(
      state.tr.setMeta(lintDecorationKey, {
        type: "lintDecoration/set",
        diagnostics: [
          diag("first", "warning", 0, 5),
          diag("second", "warning", 6, 11),
        ],
      }),
    );

    state = state.apply(state.tr.insertText("X", 3));

    expect(getDecoRuleIds(state)).toEqual(["second"]);
    expect(getDecoSet(state).find()[0]).toMatchObject({ from: 9, to: 14 });
  });

  it("restores a dropped textblock decoration from fresh diagnostics", () => {
    let state = docState("alpha", "bravo");
    state = state.apply(
      state.tr.setMeta(lintDecorationKey, {
        type: "lintDecoration/set",
        diagnostics: [
          diag("first", "warning", 0, 5),
          diag("second", "warning", 6, 11),
        ],
      }),
    );
    state = state.apply(state.tr.insertText("X", 3));
    expect(getDecoRuleIds(state)).toEqual(["second"]);

    state = state.apply(
      state.tr.setMeta(lintDecorationKey, {
        type: "lintDecoration/set",
        diagnostics: [
          diag("first-fresh", "warning", 0, 6),
          diag("second-fresh", "warning", 7, 12),
        ],
      }),
    );

    expect(getDecoRuleIds(state)).toEqual(["first-fresh", "second-fresh"]);
  });

  it("keeps mapping decorations during IME composition", () => {
    let state = docState("alpha", "bravo");
    state = state.apply(
      state.tr.setMeta(lintDecorationKey, {
        type: "lintDecoration/set",
        diagnostics: [
          diag("first", "warning", 0, 5),
          diag("second", "warning", 6, 11),
        ],
      }),
    );

    state = state.apply(state.tr.insertText("X", 3).setMeta("composition", 1));

    expect(getDecoRuleIds(state)).toEqual(["first", "second"]);
  });

  it("keeps the mapping fallback for multi-step and structural edits", () => {
    const seed = () => {
      let state = docState("alpha", "bravo");
      state = state.apply(
        state.tr.setMeta(lintDecorationKey, {
          type: "lintDecoration/set",
          diagnostics: [
            diag("first", "warning", 0, 5),
            diag("second", "warning", 6, 11),
          ],
        }),
      );
      return state;
    };

    let multiStepState = seed();
    const multiStep = multiStepState.tr.insertText("X", 3).insertText("Y", 4);
    expect(multiStep.steps).toHaveLength(2);
    multiStepState = multiStepState.apply(multiStep);
    expect(new Set(getDecoRuleIds(multiStepState))).toEqual(
      new Set(["first", "second"]),
    );

    let structuralState = seed();
    structuralState = structuralState.apply(structuralState.tr.split(3));
    expect(new Set(getDecoRuleIds(structuralState))).toEqual(
      new Set(["first", "second"]),
    );
  });
});

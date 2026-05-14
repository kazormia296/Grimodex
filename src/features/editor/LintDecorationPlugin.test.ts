import { describe, it, expect } from "vitest";
import { EditorState } from "@tiptap/pm/state";
import { schema } from "prosemirror-schema-basic";
import { DecorationSet } from "@tiptap/pm/view";

import type { Diagnostic } from "@/features/lint/types";
import {
  createLintDecorationPlugin,
  lintDecorationKey,
} from "./LintDecorationPlugin";

function docState(text: string): EditorState {
  return EditorState.create({
    doc: schema.nodes.doc.create({}, [
      schema.nodes.paragraph.create({}, [schema.text(text)]),
    ]),
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
  return lintDecorationKey.getState(state) as DecorationSet;
}

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
});

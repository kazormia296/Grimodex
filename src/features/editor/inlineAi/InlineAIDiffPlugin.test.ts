import { describe, it, expect, beforeEach } from "vitest";
import { EditorState } from "@tiptap/pm/state";
import { schema } from "prosemirror-schema-basic";
import { DecorationSet } from "@tiptap/pm/view";

import {
  inlineAiDiffKey,
  createInlineAIDiffPlugin,
} from "./InlineAIDiffPlugin";
import { useInlineAiStore } from "./inlineAiStore";

function makeState(text: string): EditorState {
  return EditorState.create({
    doc: schema.nodes.doc.create({}, [
      schema.nodes.paragraph.create({}, [schema.text(text)]),
    ]),
    plugins: [createInlineAIDiffPlugin()],
  });
}

function decoSet(state: EditorState): DecorationSet {
  return inlineAiDiffKey.getState(state) as DecorationSet;
}

function forceUpdate(state: EditorState): EditorState {
  const tr = state.tr.setMeta("inlineAiDiffUpdate", true);
  return state.apply(tr);
}

describe("InlineAIDiffPlugin", () => {
  beforeEach(() => {
    useInlineAiStore.getState().reset();
  });

  it("emits no decorations when idle", () => {
    const state = makeState("hello world");
    expect(decoSet(state)).toBe(DecorationSet.empty);
  });

  it("renders .diff-add on generated range in insert mode", () => {
    const state = makeState("hello world");
    const ac = new AbortController();
    useInlineAiStore.getState().startGeneration({
      commandId: "continue",
      mode: "insert",
      originalRange: null,
      originalText: "",
      insertPos: 6,
      abortController: ac,
    });
    useInlineAiStore.getState().setGeneratedRange({ from: 6, to: 11 });

    const next = forceUpdate(state);
    const decos = decoSet(next).find();
    expect(decos).toHaveLength(1);
    const spec = decos[0] as unknown as { type: { attrs: { class: string } } };
    expect(spec.type.attrs.class).toBe("diff-add");
  });

  it("renders both .diff-remove and .diff-add in replace mode", () => {
    const state = makeState("hello world");
    const ac = new AbortController();
    // Original selection covers "hello" at PM [1,6). Generated text is
    // appended directly after at PM [6,11) (simulating "brave").
    useInlineAiStore.getState().startGeneration({
      commandId: "rewrite",
      mode: "replace",
      originalRange: { from: 1, to: 6 },
      originalText: "hello",
      insertPos: null,
      abortController: ac,
    });
    useInlineAiStore.getState().setGeneratedRange({ from: 6, to: 11 });

    const next = forceUpdate(state);
    const decos = decoSet(next).find();
    expect(decos).toHaveLength(2);

    const classes = decos
      .map(
        (d) =>
          (d as unknown as { type: { attrs: { class: string } } }).type.attrs
            .class,
      )
      .sort();
    expect(classes).toEqual(["diff-add", "diff-remove"]);
  });

  it("drops decorations on reset", () => {
    const state = makeState("hello world");
    const ac = new AbortController();
    useInlineAiStore.getState().startGeneration({
      commandId: "continue",
      mode: "insert",
      originalRange: null,
      originalText: "",
      insertPos: 1,
      abortController: ac,
    });
    useInlineAiStore.getState().setGeneratedRange({ from: 1, to: 6 });

    const afterShow = forceUpdate(state);
    expect(decoSet(afterShow).find()).toHaveLength(1);

    useInlineAiStore.getState().reset();
    const afterReset = forceUpdate(afterShow);
    expect(decoSet(afterReset)).toBe(DecorationSet.empty);
  });
});

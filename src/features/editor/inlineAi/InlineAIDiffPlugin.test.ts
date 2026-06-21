import { describe, it, expect, beforeEach } from "vitest";
import { EditorState } from "@tiptap/pm/state";
import { schema } from "prosemirror-schema-basic";
import { DecorationSet } from "@tiptap/pm/view";
import type { Editor } from "@tiptap/core";

import {
  inlineAiDiffKey,
  createInlineAIDiffPlugin,
} from "./InlineAIDiffPlugin";
import { useInlineAiStore } from "./inlineAiStore";

function makeState(text: string, owner?: Editor): EditorState {
  return EditorState.create({
    doc: schema.nodes.doc.create({}, [
      schema.nodes.paragraph.create({}, [schema.text(text)]),
    ]),
    plugins: [createInlineAIDiffPlugin(owner)],
  });
}

// owner ゲートは identity 比較のみなので、テストではセンチネルで十分。
const OWNER_A = { __id: "A" } as unknown as Editor;
const OWNER_B = { __id: "B" } as unknown as Editor;

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

// グローバル単一 store を複数エディタが共有する linear / split view 向けの
// owner ゲート。生成中でないエディタが他人のセッションの装飾を描いたり、
// ストリーミング中に隣のエディタの入力をサイレントに握りつぶしたりしない。
describe("InlineAIDiffPlugin: owner ゲート (複数エディタ共有)", () => {
  beforeEach(() => {
    useInlineAiStore.getState().reset();
  });

  function startInsertSession(activeEditor: Editor) {
    useInlineAiStore.getState().startGeneration({
      commandId: "continue",
      mode: "insert",
      originalRange: null,
      originalText: "",
      insertPos: 6,
      abortController: new AbortController(),
      activeEditor,
    });
    useInlineAiStore.getState().setGeneratedRange({ from: 6, to: 11 });
  }

  it("別エディタが所有するセッションでは装飾しない", () => {
    const state = makeState("hello world", OWNER_A);
    startInsertSession(OWNER_B);
    const next = forceUpdate(state);
    expect(decoSet(next)).toBe(DecorationSet.empty);
  });

  it("自分が所有するセッションでは従来通り装飾する", () => {
    const state = makeState("hello world", OWNER_A);
    startInsertSession(OWNER_A);
    const next = forceUpdate(state);
    expect(decoSet(next).find()).toHaveLength(1);
  });

  it("別エディタのセッション中は生の入力を握りつぶさない", () => {
    const state = makeState("hello world", OWNER_A);
    startInsertSession(OWNER_B);
    // status === generating だが foreign。meta 無しの docChanged tr が通る。
    const next = state.apply(state.tr.insertText("X", 1));
    expect(next.doc.textContent).toContain("X");
  });

  it("自分のセッション中は生の入力を握りつぶす (従来のストリーミング保護)", () => {
    const state = makeState("hello world", OWNER_A);
    startInsertSession(OWNER_A);
    const next = state.apply(state.tr.insertText("X", 1));
    expect(next.doc.textContent).toBe("hello world");
  });
});

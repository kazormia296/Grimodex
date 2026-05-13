import { describe, it, expect } from "vitest";
import { EditorState } from "@tiptap/pm/state";
import { schema } from "prosemirror-schema-basic";
import { TextSelection } from "@tiptap/pm/state";
import type { Editor } from "@tiptap/core";

import { buildInlineAiContext } from "./inlineAiContext";

function editorLike(text: string, from: number, to: number): Editor {
  const state = EditorState.create({
    doc: schema.nodes.doc.create({}, [
      schema.nodes.paragraph.create({}, [schema.text(text)]),
    ]),
  });
  const sel = TextSelection.create(state.doc, from, to);
  const withSel = state.apply(state.tr.setSelection(sel));
  // Minimal stub: only the fields buildInlineAiContext reads.
  return {
    state: withSel,
    getText: () => withSel.doc.textBetween(0, withSel.doc.content.size, "\n"),
  } as unknown as Editor;
}

describe("buildInlineAiContext", () => {
  it("emits cursorContext with caret marker and no selectedText when no selection", () => {
    // Paragraph "hello world" → PM length 11, valid positions [1,12).
    // Put caret after "hello " = PM pos 7.
    const editor = editorLike("hello world", 7, 7);
    const ctx = buildInlineAiContext({
      editor,
      projectTitle: "P",
      sceneTitle: "S",
      matchedCodexIds: [],
      codexEntries: [],
    });
    expect(ctx.selectedText).toBeUndefined();
    expect(ctx.cursorContext).toBe("hello 【カーソル】world");
  });

  it("emits selectedText and no cursorContext when selection is non-empty", () => {
    const editor = editorLike("hello world", 1, 6); // "hello"
    const ctx = buildInlineAiContext({
      editor,
      projectTitle: "P",
      sceneTitle: "S",
      matchedCodexIds: [],
      codexEntries: [],
    });
    expect(ctx.selectedText).toBe("hello");
    expect(ctx.cursorContext).toBeUndefined();
  });

  it("projects matched codex entries into a summary list", () => {
    const editor = editorLike("x", 1, 1);
    const ctx = buildInlineAiContext({
      editor,
      projectTitle: "P",
      sceneTitle: "S",
      matchedCodexIds: ["a", "c"],
      codexEntries: [
        { id: "a", name: "Alice", summary: "勇敢な騎士" },
        { id: "b", name: "Bob", summary: "noise" },
        { id: "c", name: "Carol", summary: "" }, // 空 summary は除外
        { id: "d", name: "Dan", summary: null },
      ],
    });
    expect(ctx.codexSummaries).toBe("- Alice: 勇敢な騎士");
  });

  it("trims codexSummaries past the character budget", () => {
    const editor = editorLike("x", 1, 1);
    const longSummary = "あ".repeat(2000);
    const ctx = buildInlineAiContext({
      editor,
      projectTitle: "P",
      sceneTitle: "S",
      matchedCodexIds: ["a", "b"],
      codexEntries: [
        { id: "a", name: "A", summary: longSummary },
        { id: "b", name: "B", summary: longSummary },
      ],
    });
    // 1件目は入るが、2件目を足すと上限を超えるので切り捨てられる
    expect(ctx.codexSummaries.split("\n")).toHaveLength(1);
  });

  it("passes through scene/project/arg fields", () => {
    const editor = editorLike("hello", 1, 1);
    const ctx = buildInlineAiContext({
      editor,
      projectTitle: "MyProject",
      sceneTitle: "Scene1",
      matchedCodexIds: [],
      codexEntries: [],
      arg: "playful",
    });
    expect(ctx.projectTitle).toBe("MyProject");
    expect(ctx.sceneTitle).toBe("Scene1");
    expect(ctx.sceneText).toBe("hello");
    expect(ctx.arg).toBe("playful");
  });
});

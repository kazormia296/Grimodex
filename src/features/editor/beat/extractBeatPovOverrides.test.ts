// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { AuthorshipMark } from "@/features/attribution/AuthorshipMark";
import { SceneBeatNode } from "@/features/editor/SceneBeatNode";
import { GeneratedProseBlockNode } from "@/features/editor/GeneratedProseBlockNode";
import { extractBeatPovOverrides } from "./extractBeatPovOverrides";

function createEditor() {
  return new Editor({
    extensions: [
      StarterKit,
      AuthorshipMark,
      SceneBeatNode,
      GeneratedProseBlockNode,
    ],
    content: "",
  });
}

describe("extractBeatPovOverrides", () => {
  it("空の doc は空配列を返す", () => {
    const editor = createEditor();
    expect(extractBeatPovOverrides(editor.state.doc)).toEqual([]);
    editor.destroy();
  });

  it("pov なしの beat は無視する", () => {
    const editor = createEditor();
    editor.commands.insertContent({
      type: "sceneBeat",
      attrs: { id: "b1", beatType: "free", pov: null },
      content: [{ type: "text", text: "beat text" }],
    });
    expect(extractBeatPovOverrides(editor.state.doc)).toEqual([]);
    editor.destroy();
  });

  it("pov ありの beat から ID を抽出する", () => {
    const editor = createEditor();
    editor.commands.insertContent({
      type: "sceneBeat",
      attrs: { id: "b1", beatType: "free", pov: "char-1" },
      content: [{ type: "text", text: "beat text" }],
    });
    const result = extractBeatPovOverrides(editor.state.doc);
    expect(result).toEqual(["char-1"]);
    editor.destroy();
  });

  it("複数 beat で同じ pov は重複排除する", () => {
    const editor = createEditor();
    editor.commands.insertContent([
      {
        type: "sceneBeat",
        attrs: { id: "b1", beatType: "free", pov: "char-1" },
        content: [{ type: "text", text: "beat 1" }],
      },
      {
        type: "sceneBeat",
        attrs: { id: "b2", beatType: "free", pov: "char-1" },
        content: [{ type: "text", text: "beat 2" }],
      },
    ]);
    const result = extractBeatPovOverrides(editor.state.doc);
    expect(result).toEqual(["char-1"]);
    editor.destroy();
  });

  it("複数 beat で異なる pov を全て返す", () => {
    const editor = createEditor();
    editor.commands.insertContent([
      {
        type: "sceneBeat",
        attrs: { id: "b1", beatType: "free", pov: "char-1" },
        content: [{ type: "text", text: "beat 1" }],
      },
      {
        type: "sceneBeat",
        attrs: { id: "b2", beatType: "free", pov: "char-2" },
        content: [{ type: "text", text: "beat 2" }],
      },
    ]);
    const result = extractBeatPovOverrides(editor.state.doc);
    expect(result).toContain("char-1");
    expect(result).toContain("char-2");
    expect(result).toHaveLength(2);
    editor.destroy();
  });

  it("シーン POV と同じ beat POV も含める（フィルタリングはレンダー時）", () => {
    const editor = createEditor();
    editor.commands.insertContent({
      type: "sceneBeat",
      attrs: { id: "b1", beatType: "free", pov: "scene-pov-char" },
      content: [{ type: "text", text: "beat text" }],
    });
    const result = extractBeatPovOverrides(editor.state.doc);
    expect(result).toEqual(["scene-pov-char"]);
    editor.destroy();
  });
});

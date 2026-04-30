// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { AuthorshipMark } from "@/features/attribution/AuthorshipMark";
import { SceneBeatNode } from "@/features/editor/SceneBeatNode";
import { GeneratedProseBlockNode } from "@/features/editor/GeneratedProseBlockNode";
import { getEditorExtensions } from "@/features/editor/extensions";
import { vi } from "vitest";
import { extractBeatMentions } from "./extractBeatMentions";

function createEditor() {
  return new Editor({
    extensions: getEditorExtensions({ setMentionPopup: vi.fn() }),
    content: "",
  });
}

function createMinimalEditor() {
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

describe("extractBeatMentions", () => {
  it("空の doc は空配列を返す", () => {
    const editor = createMinimalEditor();
    expect(extractBeatMentions(editor.state.doc)).toEqual([]);
    editor.destroy();
  });

  it("mention ノードのない beat は抽出しない", () => {
    const editor = createMinimalEditor();
    editor.commands.insertContent({
      type: "sceneBeat",
      attrs: { id: "b1", beatType: "free", pov: null, collapsed: false },
      content: [{ type: "text", text: "plain text" }],
    });
    expect(extractBeatMentions(editor.state.doc)).toEqual([]);
    editor.destroy();
  });

  it("beat 内の mention を正しく抽出する", () => {
    const editor = createEditor();
    editor.commands.insertContent({
      type: "sceneBeat",
      attrs: { id: "b1", beatType: "free", pov: null, collapsed: false },
      content: [
        {
          type: "mention",
          attrs: { id: "char1", label: "ドロシー", role: "actor" },
        },
      ],
    });
    const result = extractBeatMentions(editor.state.doc);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      beatId: "b1",
      codexId: "char1",
      role: "actor",
    });
    editor.destroy();
  });

  it("同一 (beatId, codexId) の複数 mention は actor > target > mentioned で集約する", () => {
    const editor = createEditor();
    editor.commands.insertContent({
      type: "sceneBeat",
      attrs: { id: "b1", beatType: "free", pov: null, collapsed: false },
      content: [
        {
          type: "mention",
          attrs: { id: "char1", label: "X", role: "mentioned" },
        },
        { type: "text", text: " " },
        { type: "mention", attrs: { id: "char1", label: "X", role: "actor" } },
      ],
    });
    const result = extractBeatMentions(editor.state.doc);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("actor");
    editor.destroy();
  });

  it("target は mentioned より優先されるが actor より低い", () => {
    const editor = createEditor();
    editor.commands.insertContent({
      type: "sceneBeat",
      attrs: { id: "b1", beatType: "free", pov: null, collapsed: false },
      content: [
        {
          type: "mention",
          attrs: { id: "char1", label: "X", role: "mentioned" },
        },
        { type: "text", text: " " },
        { type: "mention", attrs: { id: "char1", label: "X", role: "target" } },
      ],
    });
    const result = extractBeatMentions(editor.state.doc);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("target");
    editor.destroy();
  });

  it("複数 beat の mention をそれぞれ抽出する", () => {
    const editor = createEditor();
    editor.commands.insertContent({
      type: "sceneBeat",
      attrs: { id: "b1", beatType: "free", pov: null, collapsed: false },
      content: [
        { type: "mention", attrs: { id: "char1", label: "A", role: "actor" } },
      ],
    });
    editor.commands.insertContentAt(editor.state.doc.content.size, {
      type: "paragraph",
    });
    editor.commands.insertContentAt(editor.state.doc.content.size, {
      type: "sceneBeat",
      attrs: { id: "b2", beatType: "free", pov: null, collapsed: false },
      content: [
        { type: "mention", attrs: { id: "char2", label: "B", role: "target" } },
      ],
    });
    const result = extractBeatMentions(editor.state.doc);
    expect(result).toHaveLength(2);
    expect(result.find((r) => r.beatId === "b1")).toEqual({
      beatId: "b1",
      codexId: "char1",
      role: "actor",
    });
    expect(result.find((r) => r.beatId === "b2")).toEqual({
      beatId: "b2",
      codexId: "char2",
      role: "target",
    });
    editor.destroy();
  });
});

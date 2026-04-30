// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { SceneBeatNode } from "@/features/editor/SceneBeatNode";
import { GeneratedProseBlockNode } from "@/features/editor/GeneratedProseBlockNode";
import { countBeats } from "./countBeats";

function makeEditor(jsonContent: object) {
  return new Editor({
    extensions: [StarterKit, SceneBeatNode, GeneratedProseBlockNode],
    content: jsonContent,
  });
}

describe("countBeats", () => {
  it("returns 0/0 for empty doc", () => {
    const editor = makeEditor({ type: "doc", content: [] });
    expect(countBeats(editor.state.doc)).toEqual({ total: 0, generated: 0 });
  });

  it("counts placed beats correctly", () => {
    const editor = makeEditor({
      type: "doc",
      content: [
        {
          type: "sceneBeat",
          attrs: { id: "b1", beatType: "free", collapsed: false, pov: null },
          content: [],
        },
        {
          type: "sceneBeat",
          attrs: { id: "b2", beatType: "free", collapsed: false, pov: null },
          content: [],
        },
      ],
    });
    expect(countBeats(editor.state.doc)).toEqual({ total: 2, generated: 0 });
  });

  it("counts generated beats (those with matching generatedProseBlock)", () => {
    const editor = makeEditor({
      type: "doc",
      content: [
        {
          type: "sceneBeat",
          attrs: { id: "b1", beatType: "free", collapsed: false, pov: null },
          content: [],
        },
        {
          type: "generatedProseBlock",
          attrs: { beatId: "b1", modified: false },
          content: [{ type: "paragraph", content: [] }],
        },
        {
          type: "sceneBeat",
          attrs: { id: "b2", beatType: "free", collapsed: false, pov: null },
          content: [],
        },
      ],
    });
    expect(countBeats(editor.state.doc)).toEqual({ total: 2, generated: 1 });
  });

  it("ignores generatedProseBlock whose beatId has no matching beat", () => {
    const editor = makeEditor({
      type: "doc",
      content: [
        {
          type: "generatedProseBlock",
          attrs: { beatId: "orphan", modified: false },
          content: [{ type: "paragraph", content: [] }],
        },
      ],
    });
    expect(countBeats(editor.state.doc)).toEqual({ total: 0, generated: 0 });
  });
});

// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { SceneBeatNode } from "@/features/editor/SceneBeatNode";
import { GeneratedProseBlockNode } from "@/features/editor/GeneratedProseBlockNode";
import { AuthorshipMark } from "@/features/attribution/AuthorshipMark";
import {
  BracketInstructionDecoration,
  BRACKET_CLASS,
} from "./BracketInstructionDecoration";

function createEditor(content = "") {
  return new Editor({
    extensions: [
      StarterKit,
      SceneBeatNode,
      GeneratedProseBlockNode,
      AuthorshipMark,
      BracketInstructionDecoration,
    ],
    content,
  });
}

function countBracketDecos(editor: Editor): number {
  // Check view decorations via the plugin state key
  const { state } = editor;
  let count = 0;
  // Walk the doc and find decorations by checking the plugin's getState
  for (const plugin of state.plugins) {
    const pluginState = plugin.getState(state);
    if (pluginState && typeof pluginState.find === "function") {
      const found = pluginState.find();
      if (found.length > 0 && found[0].spec?.class === BRACKET_CLASS) {
        count += found.length;
        break;
      }
    }
  }
  return count;
}

describe("BracketInstructionDecoration", () => {
  it("sceneBeat 内の [bracket] テキストを装飾する", () => {
    const editor = createEditor();
    editor
      .chain()
      .focus()
      .insertContent({
        type: "sceneBeat",
        attrs: { id: "b1", beatType: "free", pov: null, collapsed: false },
        content: [{ type: "text", text: "[slow down] 何か起こる" }],
      })
      .run();

    const count = countBracketDecos(editor);
    expect(count).toBeGreaterThan(0);
    editor.destroy();
  });

  it("通常の paragraph 内の [bracket] は装飾しない", () => {
    const editor = createEditor("<p>[これは本文]通常の文章</p>");
    const count = countBracketDecos(editor);
    expect(count).toBe(0);
    editor.destroy();
  });

  it("sceneBeat 内に複数の [bracket] があれば複数装飾する", () => {
    const editor = createEditor();
    editor
      .chain()
      .focus()
      .insertContent({
        type: "sceneBeat",
        attrs: { id: "b1", beatType: "free", pov: null, collapsed: false },
        content: [
          { type: "text", text: "[slow down] foo [expand] bar [end here]" },
        ],
      })
      .run();

    const count = countBracketDecos(editor);
    expect(count).toBe(3);
    editor.destroy();
  });

  it("空の [] は装飾しない（最低1文字必要）", () => {
    const editor = createEditor();
    editor
      .chain()
      .focus()
      .insertContent({
        type: "sceneBeat",
        attrs: { id: "b1", beatType: "free", pov: null, collapsed: false },
        content: [{ type: "text", text: "[] テキスト" }],
      })
      .run();

    const count = countBracketDecos(editor);
    expect(count).toBe(0);
    editor.destroy();
  });

  it("generatedProseBlock 内の [bracket] は装飾しない", () => {
    const editor = createEditor();
    editor
      .chain()
      .focus()
      .insertContent([
        {
          type: "sceneBeat",
          attrs: { id: "b1", beatType: "free", pov: null, collapsed: false },
          content: [{ type: "text", text: "通常指示" }],
        },
        {
          type: "generatedProseBlock",
          attrs: { beatId: "b1", modified: false },
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "[これは生成prose内]" }],
            },
          ],
        },
      ])
      .run();

    // sceneBeat 内には bracket なし、generatedProseBlock 内のみにある
    const count = countBracketDecos(editor);
    expect(count).toBe(0);
    editor.destroy();
  });
});

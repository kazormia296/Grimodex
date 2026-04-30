// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { SceneBeatNode } from "./SceneBeatNode";
import { GeneratedProseBlockNode } from "./GeneratedProseBlockNode";
import { AuthorshipMark } from "@/features/attribution/AuthorshipMark";
import { countSceneBodyChars } from "./charCountForBody";

function createEditor(content = "") {
  return new Editor({
    extensions: [
      StarterKit,
      SceneBeatNode,
      GeneratedProseBlockNode,
      AuthorshipMark,
    ],
    content,
  });
}

describe("countSceneBodyChars", () => {
  it("通常段落のテキストを集計する", () => {
    const editor = createEditor("<p>あいうえお</p>");
    expect(countSceneBodyChars(editor.state.doc)).toBe(5);
    editor.destroy();
  });

  it("sceneBeat 内のテキストを除外する", () => {
    const editor = createEditor();
    editor
      .chain()
      .focus()
      .insertContent([
        { type: "paragraph", content: [{ type: "text", text: "本文" }] },
        {
          type: "sceneBeat",
          attrs: { id: "b1", beatType: "free", pov: null, collapsed: false },
          content: [{ type: "text", text: "ビート指示100文字" }],
        },
      ])
      .run();
    // "本文" (2文字) のみカウント。Beat内は除外。
    expect(countSceneBodyChars(editor.state.doc)).toBe(2);
    editor.destroy();
  });

  it("generatedProseBlock 内のテキストは含める", () => {
    const editor = createEditor();
    editor
      .chain()
      .focus()
      .insertContent([
        {
          type: "sceneBeat",
          attrs: { id: "b1", beatType: "free", pov: null, collapsed: false },
          content: [{ type: "text", text: "ビート指示" }],
        },
        {
          type: "generatedProseBlock",
          attrs: { beatId: "b1", modified: false },
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "生成prose" }],
            },
          ],
        },
      ])
      .run();
    // "生成prose" (7文字) は含める。"ビート指示" (5文字) は除外。
    expect(countSceneBodyChars(editor.state.doc)).toBe(7);
    editor.destroy();
  });

  it("空ドキュメントは0を返す", () => {
    const editor = createEditor();
    expect(countSceneBodyChars(editor.state.doc)).toBe(0);
    editor.destroy();
  });

  it("複数段落と複数ビートが混在する場合", () => {
    const editor = createEditor();
    editor
      .chain()
      .focus()
      .insertContent([
        { type: "paragraph", content: [{ type: "text", text: "ABC" }] },
        {
          type: "sceneBeat",
          attrs: { id: "b1", beatType: "free", pov: null, collapsed: false },
          content: [{ type: "text", text: "除外テキスト" }],
        },
        { type: "paragraph", content: [{ type: "text", text: "DEF" }] },
        {
          type: "sceneBeat",
          attrs: { id: "b2", beatType: "free", pov: null, collapsed: false },
          content: [{ type: "text", text: "これも除外" }],
        },
        { type: "paragraph", content: [{ type: "text", text: "GHI" }] },
      ])
      .run();
    // "ABC" + "DEF" + "GHI" = 9
    expect(countSceneBodyChars(editor.state.doc)).toBe(9);
    editor.destroy();
  });
});
